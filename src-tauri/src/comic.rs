//! Comic archive vault: content-addressed CBZ/ZIP store with random-access page extraction.
//!
//! Port of `main/comicArchiveController.cjs` (321 lines). The archive itself never reaches
//! the renderer: bytes land in `<app data dir>/comic-archive/<sha256>.cbz`, the renderer gets
//! the page manifest and single pages inflated on demand, bounded by the same two limits the
//! Electron build uses (open-archive LRU + inflated page byte budget).
//!
//! ZIP random access is a hand-written central-directory reader — the ZIP spec is public and
//! the production path (seek + partial read) and the test path (whole buffer) share one set of
//! pure functions, so there is no second source of truth. ZIP64 / encrypted entries / any
//! method other than store(0)+deflate(8) are rejected, same as upstream — long-form archives
//! under 512 MiB never need ZIP64.
//!
//! Deliberate divergences from the CJS source, all in the "fail loudly" direction:
//!   * `stored` entries whose data block is shorter than the declared uncompressed size are an
//!     error instead of a silently shorter slice.
//!   * a central directory that points outside the archive is "comic archive is truncated".

//! Commands land in the crate handler table from `main.rs` (the Lead's file), so most items are
//! unreferenced from this module's perspective until that wiring lands.
#![allow(dead_code)]

use std::cmp::Ordering;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Deserializer, Serialize};
use tauri::{Manager, WebviewWindow};
use url::Url;

pub const MAX_COMIC_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
pub const MAX_COMIC_PAGE_COUNT: usize = 2000;
pub const MAX_COMIC_PAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_COMIC_ARCHIVE_ENTRIES: usize = 20_000;
pub const MAX_OPEN_ARCHIVES: usize = 6;
pub const MAX_PAGE_CACHE_BYTES: usize = 64 * 1024 * 1024;
/// EOCD + comment search window: 22-byte EOCD structure + 65535-byte comment cap + slack.
const EOCD_SCAN_BYTES: usize = 22 + 65535 + 64;

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CDE_SIGNATURE: u32 = 0x0201_4b50;
const LFH_SIGNATURE: u32 = 0x0403_4b50;

/// Every user-visible failure carries the exact message the renderer shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComicArchiveError(String);

impl ComicArchiveError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ComicArchiveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ComicArchiveError {}

type ComicResult<T> = Result<T, ComicArchiveError>;

const fn mib(bytes: usize) -> usize {
    bytes / 1024 / 1024
}

// ———————————————————————————— little-endian readers ————————————————————————————

/// Bounds-checked LE u32. Untrusted input hits this first.
fn read_u32(buffer: &[u8], offset: usize) -> ComicResult<u32> {
    if offset + 4 > buffer.len() {
        return Err(ComicArchiveError::new("comic archive is truncated"));
    }
    Ok(u32::from_le_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ]))
}

fn read_u16(buffer: &[u8], offset: usize) -> ComicResult<u16> {
    if offset + 2 > buffer.len() {
        return Err(ComicArchiveError::new("comic archive is truncated"));
    }
    Ok(u16::from_le_bytes([buffer[offset], buffer[offset + 1]]))
}

// ———————————————————————————— name / MIME classification ————————————————————————————

/// Last path segment's extension, lowercased. No extension → empty.
fn extension_for(name: &str) -> String {
    let clean = name.rsplit('/').next().unwrap_or(name);
    match clean.rfind('.') {
        None => String::new(),
        Some(dot) => clean[dot + 1..].to_lowercase(),
    }
}

pub fn page_mime_for(name: &str) -> Option<&'static str> {
    match extension_for(name).as_str() {
        "avif" => Some("image/avif"),
        "gif" => Some("image/gif"),
        "jpeg" => Some("image/jpeg"),
        "jpg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn is_metadata_entry(name: &str) -> bool {
    name.ends_with('/')
        || name.starts_with("__MACOSX/")
        || name.split('/').any(|part| part == ".DS_Store")
}

pub fn is_page_entry(name: &str) -> bool {
    !is_metadata_entry(name) && page_mime_for(name).is_some()
}

// ———————————————————————————— natural page order ————————————————————————————

/// `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })` equivalent:
/// digit runs compare as numbers, everything else case-insensitively. Ties stay equal so the
/// stable sort preserves archive order, exactly like the CJS version.
pub fn natural_cmp(left: &str, right: &str) -> Ordering {
    let a: Vec<char> = left.chars().collect();
    let b: Vec<char> = right.chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let start_a = i;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            let start_b = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let digits_a: String = a[start_a..i].iter().collect();
            let digits_b: String = b[start_b..j].iter().collect();
            let trimmed_a = digits_a.trim_start_matches('0');
            let trimmed_b = digits_b.trim_start_matches('0');
            let order = trimmed_a
                .len()
                .cmp(&trimmed_b.len())
                .then_with(|| trimmed_a.cmp(trimmed_b));
            if order != Ordering::Equal {
                return order;
            }
            continue;
        }
        let lower_a = a[i].to_lowercase().collect::<String>();
        let lower_b = b[j].to_lowercase().collect::<String>();
        let order = lower_a.cmp(&lower_b);
        if order != Ordering::Equal {
            return order;
        }
        i += 1;
        j += 1;
    }
    (a.len() - i).cmp(&(b.len() - j))
}

// ———————————————————————————— central directory ————————————————————————————

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComicEntry {
    pub name: String,
    pub flags: u16,
    pub method: u16,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
}

#[derive(Debug, Clone, Copy)]
struct Eocd {
    cd_offset: u64,
    cd_size: u64,
}

/// Locate the EOCD in a file tail (`tail_start_offset` is where it begins in the archive).
fn find_eocd(tail: &[u8], _tail_start_offset: u64) -> ComicResult<Eocd> {
    if tail.len() < 22 {
        return Err(ComicArchiveError::new("Could not read this comic archive."));
    }
    for i in (0..=tail.len() - 22).rev() {
        if read_u32(tail, i)? != EOCD_SIGNATURE {
            continue;
        }
        let cd_size = u64::from(read_u32(tail, i + 12)?);
        let cd_offset = u64::from(read_u32(tail, i + 16)?);
        let comment_length = usize::from(read_u16(tail, i + 20)?);
        // The comment must end exactly at EOF, otherwise this is not the real EOCD.
        if i + 22 + comment_length != tail.len() {
            continue;
        }
        if cd_offset == 0xffff_ffff || cd_size == 0xffff_ffff {
            return Err(ComicArchiveError::new(
                "ZIP64 comic archives are not supported.",
            ));
        }
        return Ok(Eocd { cd_offset, cd_size });
    }
    Err(ComicArchiveError::new(
        "Could not read this comic archive.",
    ))
}

/// Parse a central-directory slice. `base` is where `cd_buffer[0]` sits in the archive.
fn parse_central_directory(cd_buffer: &[u8], base: u64) -> ComicResult<Vec<ComicEntry>> {
    let mut entries = Vec::new();
    let mut cursor = 0usize;
    while cursor + 46 <= cd_buffer.len() {
        if read_u32(cd_buffer, cursor)? != CDE_SIGNATURE {
            break;
        }
        let flags = read_u16(cd_buffer, cursor + 8)?;
        let method = read_u16(cd_buffer, cursor + 10)?;
        let compressed_size = u64::from(read_u32(cd_buffer, cursor + 20)?);
        let uncompressed_size = u64::from(read_u32(cd_buffer, cursor + 24)?);
        let name_length = usize::from(read_u16(cd_buffer, cursor + 28)?);
        let extra_length = usize::from(read_u16(cd_buffer, cursor + 30)?);
        let comment_length = usize::from(read_u16(cd_buffer, cursor + 32)?);
        let local_header_offset = u64::from(read_u32(cd_buffer, cursor + 42)?);
        let name_end = cursor + 46 + name_length;
        if name_end + extra_length + comment_length > cd_buffer.len() {
            return Err(ComicArchiveError::new("comic archive is truncated"));
        }
        let name = String::from_utf8_lossy(&cd_buffer[cursor + 46..name_end]).into_owned();
        entries.push(ComicEntry {
            name,
            flags,
            method,
            compressed_size,
            uncompressed_size,
            local_header_offset: base + local_header_offset,
        });
        cursor = name_end + extra_length + comment_length;
    }
    Ok(entries)
}

/// Whole-buffer page manifest — used by import and shared with the gated tests.
fn list_comic_pages(archive: &[u8]) -> ComicResult<Vec<ComicEntry>> {
    if archive.len() > MAX_COMIC_ARCHIVE_BYTES {
        return Err(ComicArchiveError::new(format!(
            "Comic archives are limited to {} MiB.",
            mib(MAX_COMIC_ARCHIVE_BYTES)
        )));
    }
    let tail_start = archive.len().saturating_sub(EOCD_SCAN_BYTES);
    let eocd = find_eocd(&archive[tail_start..], tail_start as u64)?;
    let cd_end = eocd.cd_offset.saturating_add(eocd.cd_size);
    if cd_end > archive.len() as u64 {
        return Err(ComicArchiveError::new("comic archive is truncated"));
    }
    let entries = parse_central_directory(
        &archive[eocd.cd_offset as usize..cd_end as usize],
        eocd.cd_offset,
    )?;
    if entries.len() > MAX_COMIC_ARCHIVE_ENTRIES {
        return Err(ComicArchiveError::new(format!(
            "Comic archives are limited to {MAX_COMIC_ARCHIVE_ENTRIES} entries."
        )));
    }
    let mut pages: Vec<ComicEntry> = entries
        .into_iter()
        .filter(|entry| is_page_entry(&entry.name))
        .collect();
    if pages.is_empty() {
        return Err(ComicArchiveError::new(
            "Comic archives need at least one JPG, PNG, WEBP, GIF, or AVIF page.",
        ));
    }
    if pages.len() > MAX_COMIC_PAGE_COUNT {
        return Err(ComicArchiveError::new(format!(
            "Comic archives are limited to {MAX_COMIC_PAGE_COUNT} pages."
        )));
    }
    for page in &pages {
        if page.uncompressed_size > MAX_COMIC_PAGE_BYTES as u64 {
            return Err(ComicArchiveError::new(format!(
                "Each comic page is limited to {} MiB.",
                mib(MAX_COMIC_PAGE_BYTES)
            )));
        }
    }
    pages.sort_by(|left, right| natural_cmp(&left.name, &right.name));
    Ok(pages)
}

/// Decompress one entry. `compressed` is the raw block behind the local header.
fn inflate_comic_entry(entry: &ComicEntry, compressed: &[u8]) -> ComicResult<Vec<u8>> {
    if entry.flags & 0x1 != 0 {
        return Err(ComicArchiveError::new(
            "Encrypted comic archives are not supported.",
        ));
    }
    if entry.uncompressed_size > MAX_COMIC_PAGE_BYTES as u64 {
        return Err(ComicArchiveError::new(format!(
            "Each comic page is limited to {} MiB.",
            mib(MAX_COMIC_PAGE_BYTES)
        )));
    }
    let expected = entry.uncompressed_size as usize;
    match entry.method {
        0 => {
            if compressed.len() < expected {
                return Err(ComicArchiveError::new("comic archive is truncated"));
            }
            Ok(compressed[..expected].to_vec())
        }
        8 => {
            let mut decoder = flate2::read::DeflateDecoder::new(compressed);
            // Cap the read one byte past the limit so a zip bomb cannot allocate past it.
            let mut inflated = Vec::with_capacity(expected.min(1024 * 1024));
            decoder
                .by_ref()
                .take(MAX_COMIC_PAGE_BYTES as u64 + 1)
                .read_to_end(&mut inflated)
                .map_err(|_| ComicArchiveError::new("comic page inflate failed"))?;
            if inflated.len() > MAX_COMIC_PAGE_BYTES {
                return Err(ComicArchiveError::new(format!(
                    "Each comic page is limited to {} MiB.",
                    mib(MAX_COMIC_PAGE_BYTES)
                )));
            }
            if inflated.len() != expected {
                return Err(ComicArchiveError::new(
                    "comic page inflate size mismatch",
                ));
            }
            Ok(inflated)
        }
        _ => Err(ComicArchiveError::new(
            "Unsupported compression inside the comic archive.",
        )),
    }
}

// ———————————————————————————— SHA-256 (ref derivation) ————————————————————————————

/// The archive reference is `sha256(bytes)` in lowercase hex — the renderer stores it in the
/// document, so it must match the Electron build exactly. `Cargo.toml` is the Lead's file, so
/// this is a self-contained implementation instead of a new dependency.
const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256_compress(state: &mut [u32; 8], block: &[u8]) {
    let mut schedule = [0u32; 64];
    for (index, word) in schedule.iter_mut().take(16).enumerate() {
        let offset = index * 4;
        *word = u32::from_be_bytes([
            block[offset],
            block[offset + 1],
            block[offset + 2],
            block[offset + 3],
        ]);
    }
    for index in 16..64 {
        let s0 = schedule[index - 15].rotate_right(7)
            ^ schedule[index - 15].rotate_right(18)
            ^ (schedule[index - 15] >> 3);
        let s1 = schedule[index - 2].rotate_right(17)
            ^ schedule[index - 2].rotate_right(19)
            ^ (schedule[index - 2] >> 10);
        schedule[index] = schedule[index - 16]
            .wrapping_add(s0)
            .wrapping_add(schedule[index - 7])
            .wrapping_add(s1);
    }
    let mut a = state[0];
    let mut b = state[1];
    let mut c = state[2];
    let mut d = state[3];
    let mut e = state[4];
    let mut f = state[5];
    let mut g = state[6];
    let mut h = state[7];
    for index in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let choose = (e & f) ^ ((!e) & g);
        let temp1 = h
            .wrapping_add(s1)
            .wrapping_add(choose)
            .wrapping_add(SHA256_K[index])
            .wrapping_add(schedule[index]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let majority = (a & b) ^ (a & c) ^ (b & c);
        let temp2 = s0.wrapping_add(majority);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(temp1);
        d = c;
        c = b;
        b = a;
        a = temp1.wrapping_add(temp2);
    }
    state[0] = state[0].wrapping_add(a);
    state[1] = state[1].wrapping_add(b);
    state[2] = state[2].wrapping_add(c);
    state[3] = state[3].wrapping_add(d);
    state[4] = state[4].wrapping_add(e);
    state[5] = state[5].wrapping_add(f);
    state[6] = state[6].wrapping_add(g);
    state[7] = state[7].wrapping_add(h);
}

fn sha256_hex(input: &[u8]) -> String {
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut chunks = input.chunks_exact(64);
    for chunk in &mut chunks {
        sha256_compress(&mut state, chunk);
    }
    let remainder = chunks.remainder();
    let mut tail = [0u8; 128];
    tail[..remainder.len()].copy_from_slice(remainder);
    tail[remainder.len()] = 0x80;
    let blocks = if remainder.len() < 56 { 1 } else { 2 };
    let bit_length = (input.len() as u64).wrapping_mul(8);
    tail[blocks * 64 - 8..blocks * 64].copy_from_slice(&bit_length.to_be_bytes());
    for index in 0..blocks {
        sha256_compress(&mut state, &tail[index * 64..(index + 1) * 64]);
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

fn is_archive_ref(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// ———————————————————————————— vault ————————————————————————————

#[derive(Debug, Clone)]
pub struct ImportOutcome {
    pub reference: String,
    pub page_names: Vec<String>,
    pub page_count: usize,
    pub byte_size: usize,
    pub original_name: String,
}

#[derive(Debug, Clone)]
pub struct PageOutcome {
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
}

struct OpenedArchive {
    reference: String,
    path: PathBuf,
    pages: Vec<ComicEntry>,
}

struct CachedPage {
    key: String,
    bytes: Vec<u8>,
    mime_type: &'static str,
}

struct VaultState {
    /// Least-recently-used first; the tail is the most recently touched archive.
    opened: Vec<OpenedArchive>,
    page_cache: Vec<CachedPage>,
    page_cache_bytes: usize,
    closed: bool,
}

/// Content-addressed comic vault held in Tauri managed state (`Arc<ComicVault>`).
pub struct ComicVault {
    dir: PathBuf,
    max_open_archives: usize,
    max_page_cache_bytes: usize,
    state: Mutex<VaultState>,
}

impl ComicVault {
    pub fn new(dir: PathBuf) -> Self {
        Self::with_limits(dir, MAX_OPEN_ARCHIVES, MAX_PAGE_CACHE_BYTES)
    }

    pub fn with_limits(dir: PathBuf, max_open_archives: usize, max_page_cache_bytes: usize) -> Self {
        Self {
            dir,
            max_open_archives,
            max_page_cache_bytes,
            state: Mutex::new(VaultState {
                opened: Vec::new(),
                page_cache: Vec::new(),
                page_cache_bytes: 0,
                closed: false,
            }),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VaultState> {
        // A poisoned lock still holds consistent data here: every critical section only
        // mutates the vault after all fallible work has succeeded.
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn archive_path(&self, reference: &str) -> ComicResult<PathBuf> {
        if !is_archive_ref(reference) {
            return Err(ComicArchiveError::new(
                "comic archive reference was rejected",
            ));
        }
        Ok(self.dir.join(format!("{reference}.cbz")))
    }

    /// Content-addressed import: identical bytes dedupe onto the same file.
    pub fn import_archive(&self, bytes: &[u8], name: Option<&str>) -> ComicResult<ImportOutcome> {
        {
            let state = self.lock();
            if state.closed {
                return Err(ComicArchiveError::new(
                    "comic archive controller is closed",
                ));
            }
        }
        if bytes.is_empty() {
            return Err(ComicArchiveError::new("Comic files are empty."));
        }
        if bytes.len() > MAX_COMIC_ARCHIVE_BYTES {
            return Err(ComicArchiveError::new(format!(
                "Comic files are limited to {} MiB.",
                mib(MAX_COMIC_ARCHIVE_BYTES)
            )));
        }
        fs::create_dir_all(&self.dir)
            .map_err(|_| ComicArchiveError::new("comic archive storage is unavailable"))?;
        let reference = sha256_hex(bytes);
        let target = self.dir.join(format!("{reference}.cbz"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                file.write_all(bytes).map_err(|error| {
                    ComicArchiveError::new(format!("comic archive write failed: {error}"))
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(ComicArchiveError::new(format!(
                    "comic archive write failed: {error}"
                )))
            }
        }
        let pages = list_comic_pages(bytes)?;
        let page_count = pages.len();
        Ok(ImportOutcome {
            reference,
            page_names: pages.into_iter().map(|page| page.name).collect(),
            page_count,
            byte_size: bytes.len(),
            original_name: name.map(|value| value.chars().take(200).collect()).unwrap_or_default(),
        })
    }

    /// Single page bytes: local header → compressed block → inflate → page cache.
    pub fn get_page(&self, reference: &str, index: f64) -> ComicResult<PageOutcome> {
        {
            let state = self.lock();
            if state.closed {
                return Err(ComicArchiveError::new(
                    "comic archive controller is closed",
                ));
            }
        }
        let path = self.archive_path(reference)?;
        let cache_key = format!("{reference}:{index}");
        if index.fract() == 0.0 && index >= 0.0 {
            let mut state = self.lock();
            if let Some(position) = state
                .page_cache
                .iter()
                .position(|cached| cached.key == cache_key)
            {
                let hit = state.page_cache.remove(position);
                let outcome = PageOutcome {
                    bytes: hit.bytes.clone(),
                    mime_type: hit.mime_type,
                };
                state.page_cache.push(CachedPage {
                    key: cache_key.clone(),
                    bytes: hit.bytes,
                    mime_type: hit.mime_type,
                });
                return Ok(outcome);
            }
        }

        let opened = self.open_archive(reference, &path)?;
        if index.fract() != 0.0 || index < 0.0 || index >= opened.pages.len() as f64 {
            return Err(ComicArchiveError::new("comic page index is out of range"));
        }
        let page_index = index as usize;
        let entry = opened.pages[page_index].clone();
        let bytes = read_entry_bytes(&opened.path, &entry)?;
        let mime_type = page_mime_for(&entry.name).ok_or_else(|| {
            ComicArchiveError::new("comic archive entry is not a readable page")
        })?;

        let mut state = self.lock();
        while state.page_cache_bytes + bytes.len() > self.max_page_cache_bytes
            && !state.page_cache.is_empty()
        {
            let evicted = state.page_cache.remove(0);
            state.page_cache_bytes = state.page_cache_bytes.saturating_sub(evicted.bytes.len());
        }
        state.page_cache_bytes += bytes.len();
        state.page_cache.push(CachedPage {
            key: cache_key,
            bytes: bytes.clone(),
            mime_type,
        });
        Ok(PageOutcome { bytes, mime_type })
    }

    /// Open (or reuse) a parsed archive; LRU-evicts the oldest manifest.
    fn open_archive(&self, reference: &str, path: &Path) -> ComicResult<OpenedArchive> {
        {
            let mut state = self.lock();
            if let Some(position) = state
                .opened
                .iter()
                .position(|opened| opened.reference == reference)
            {
                let hit = state.opened.remove(position);
                let snapshot = OpenedArchive {
                    reference: hit.reference.clone(),
                    path: hit.path.clone(),
                    pages: hit.pages.clone(),
                };
                state.opened.push(hit);
                return Ok(snapshot);
            }
        }

        let metadata = fs::metadata(path)
            .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
        if metadata.len() > MAX_COMIC_ARCHIVE_BYTES as u64 {
            return Err(ComicArchiveError::new(
                "comic archive exceeds the size limit",
            ));
        }
        let mut file = File::open(path)
            .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
        let tail_length = metadata.len().min(EOCD_SCAN_BYTES as u64) as usize;
        file.seek(SeekFrom::Start(metadata.len() - tail_length as u64))
            .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
        let mut tail = vec![0u8; tail_length];
        file.read_exact(&mut tail)
            .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
        let eocd = find_eocd(&tail, metadata.len() - tail_length as u64)?;
        if eocd.cd_offset.saturating_add(eocd.cd_size) > metadata.len() {
            return Err(ComicArchiveError::new("comic archive is truncated"));
        }
        file.seek(SeekFrom::Start(eocd.cd_offset))
            .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
        let mut cd_buffer = vec![0u8; eocd.cd_size as usize];
        file.read_exact(&mut cd_buffer)
            .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
        let entries = parse_central_directory(&cd_buffer, 0)?;
        let mut pages: Vec<ComicEntry> = entries
            .into_iter()
            .filter(|entry| is_page_entry(&entry.name))
            .collect();
        if pages.is_empty() {
            return Err(ComicArchiveError::new(
                "This comic archive has no readable pages.",
            ));
        }
        pages.sort_by(|left, right| natural_cmp(&left.name, &right.name));

        let opened = OpenedArchive {
            reference: reference.to_string(),
            path: path.to_path_buf(),
            pages,
        };
        let mut state = self.lock();
        state.opened.push(OpenedArchive {
            reference: opened.reference.clone(),
            path: opened.path.clone(),
            pages: opened.pages.clone(),
        });
        while state.opened.len() > self.max_open_archives {
            state.opened.remove(0);
        }
        Ok(opened)
    }

    pub fn close_all(&self) {
        let mut state = self.lock();
        state.closed = true;
        state.opened.clear();
        state.page_cache.clear();
        state.page_cache_bytes = 0;
    }

    #[cfg(test)]
    fn page_cache_bytes(&self) -> usize {
        self.lock().page_cache_bytes
    }

    #[cfg(test)]
    fn open_archive_count(&self) -> usize {
        self.lock().opened.len()
    }
}

/// Read one entry's compressed block through its local file header.
fn read_entry_bytes(path: &Path, entry: &ComicEntry) -> ComicResult<Vec<u8>> {
    let mut file = File::open(path)
        .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
    file.seek(SeekFrom::Start(entry.local_header_offset))
        .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
    let mut local_header = [0u8; 30];
    file.read_exact(&mut local_header)
        .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
    if u32::from_le_bytes([
        local_header[0],
        local_header[1],
        local_header[2],
        local_header[3],
    ]) != LFH_SIGNATURE
    {
        return Err(ComicArchiveError::new("comic archive is corrupted"));
    }
    let name_length = u64::from(u16::from_le_bytes([local_header[26], local_header[27]]));
    let extra_length = u64::from(u16::from_le_bytes([local_header[28], local_header[29]]));
    let data_offset = entry.local_header_offset + 30 + name_length + extra_length;
    file.seek(SeekFrom::Start(data_offset))
        .map_err(|_| ComicArchiveError::new("This comic archive is no longer available."))?;
    if entry.compressed_size > MAX_COMIC_ARCHIVE_BYTES as u64 {
        return Err(ComicArchiveError::new("comic archive is truncated"));
    }
    let mut compressed = vec![0u8; entry.compressed_size as usize];
    file.read_exact(&mut compressed)
        .map_err(|_| ComicArchiveError::new("This comic archive is truncated"))?;
    inflate_comic_entry(entry, &compressed)
}

// ———————————————————————————— Tauri wiring ————————————————————————————

/// Managed-state constructor for `main.rs`:
/// `app.manage(comic::init(app.handle())?);`
pub fn init(app: &tauri::AppHandle) -> Result<Arc<ComicVault>, tauri::Error> {
    let dir = app.path().app_data_dir()?.join("comic-archive");
    Ok(Arc::new(ComicVault::new(dir)))
}

/// Tauri repr of `preload.cjs`'s `importArchive({ bytes, name })`.
///
/// `bytes` accepts a JSON number array, the numeric-keyed object `JSON.stringify` produces
/// from a `Uint8Array`, or a base64 string — the renderer bridge has to be written by hand
/// here (there is no structured clone over Tauri IPC), and none of those forms should be a
/// silent failure.
#[derive(Deserialize)]
pub struct ComicImportRequest {
    #[serde(default, deserialize_with = "flexible_bytes")]
    bytes: Vec<u8>,
    #[serde(default)]
    name: Option<String>,
}

/// Tauri repr of `preload.cjs`'s `getPage({ ref, index })`.
#[derive(Deserialize)]
pub struct ComicPageRequest {
    #[serde(default, rename = "ref")]
    reference: Option<String>,
    #[serde(default)]
    index: Option<f64>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicImportReply {
    ok: bool,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    byte_size: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl ComicImportReply {
    fn error(message: impl ToString) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicPageReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl ComicPageReply {
    fn error(message: impl ToString) -> Self {
        Self {
            message: Some(message.to_string()),
            ..Self::default()
        }
    }
}

fn flexible_bytes<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error as DeError;
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Null => Ok(Vec::new()),
        serde_json::Value::Array(items) => items
            .into_iter()
            .map(|item| json_byte(&item).map_err(DeError::custom))
            .collect(),
        serde_json::Value::Object(map) => {
            let mut bytes = Vec::with_capacity(map.len());
            for index in 0..map.len() {
                let item = map.get(&index.to_string()).ok_or_else(|| {
                    DeError::custom("comic archive bytes must be a contiguous byte array")
                })?;
                bytes.push(json_byte(item).map_err(DeError::custom)?);
            }
            Ok(bytes)
        }
        serde_json::Value::String(text) => {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(text.as_bytes())
                .map_err(|_| DeError::custom("comic archive bytes are not valid base64"))
        }
        other => Err(DeError::custom(format!(
            "comic archive bytes must be a byte array, got {other}"
        ))),
    }
}

fn json_byte(value: &serde_json::Value) -> Result<u8, String> {
    let number = value
        .as_f64()
        .ok_or_else(|| "comic archive bytes must be numbers".to_string())?;
    if number.fract() != 0.0 || !(0.0..=255.0).contains(&number) {
        return Err("comic archive byte is out of range".to_string());
    }
    Ok(number as u8)
}

/// Same caller guard as `main.rs::authorized` (label `main` + trusted origin).
/// Duplicated on purpose while `main.rs` is the Lead's file — integrate into one helper later.
fn trusted_url(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if !cfg!(feature = "custom-protocol") {
        url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(4002)
    } else {
        (url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none())
            || (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
    }
}

fn authorized(window: &WebviewWindow) -> bool {
    window.label() == "main" && window.url().is_ok_and(|url| trusted_url(&url))
}

fn vault_of(window: &WebviewWindow) -> Option<Arc<ComicVault>> {
    window
        .app_handle()
        .try_state::<Arc<ComicVault>>()
        .map(|state| state.inner().clone())
}

/// `window.artflowComic.importArchive({ bytes, name })`
#[tauri::command]
pub async fn tauri_comic_import(
    window: WebviewWindow,
    request: ComicImportRequest,
) -> ComicImportReply {
    if !authorized(&window) {
        return ComicImportReply::error("forbidden caller");
    }
    let Some(vault) = vault_of(&window) else {
        return ComicImportReply::error("comic archive vault is unavailable");
    };
    let ComicImportRequest { bytes, name } = request;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        vault.import_archive(&bytes, name.as_deref())
    })
    .await
    .unwrap_or_else(|error| Err(ComicArchiveError::new(format!("comic import failed: {error}"))));
    match outcome {
        Ok(imported) => ComicImportReply {
            ok: true,
            reference: Some(imported.reference),
            page_names: Some(imported.page_names),
            page_count: Some(imported.page_count),
            byte_size: Some(imported.byte_size),
            original_name: Some(imported.original_name),
            message: None,
        },
        Err(error) => ComicImportReply::error(error.message()),
    }
}

/// `window.artflowComic.getPage({ ref, index })`
#[tauri::command]
pub async fn tauri_comic_get_page(
    window: WebviewWindow,
    request: ComicPageRequest,
) -> ComicPageReply {
    if !authorized(&window) {
        return ComicPageReply::error("forbidden caller");
    }
    let Some(vault) = vault_of(&window) else {
        return ComicPageReply::error("comic archive vault is unavailable");
    };
    let reference = match request.reference.as_deref() {
        Some(value) if is_archive_ref(value) => value.to_string(),
        _ => return ComicPageReply::error("comic archive reference was rejected"),
    };
    let index = request.index.unwrap_or(f64::NAN);
    let outcome =
        tauri::async_runtime::spawn_blocking(move || vault.get_page(&reference, index))
            .await
            .unwrap_or_else(|error| {
                Err(ComicArchiveError::new(format!("comic page read failed: {error}")))
            });
    match outcome {
        Ok(page) => ComicPageReply {
            ok: true,
            bytes: Some(page.bytes),
            mime_type: Some(page.mime_type.to_string()),
            message: None,
        },
        Err(error) => ComicPageReply::error(error.message()),
    }
}

/// Called on quit so cached page bytes are released with the process.
pub fn shutdown(vault: &ComicVault) {
    vault.close_all();
}

// ———————————————————————————— tests ————————————————————————————

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    // —— hand-built ZIP fixtures (no external files) ——

    struct Spec {
        name: String,
        method: u16,
        payload: Vec<u8>,
        /// Uncompressed size written into both headers; defaults to `payload.len()`.
        uncompressed_len: usize,
        declared_uncompressed: Option<u32>,
        flags: u16,
    }

    impl Spec {
        fn stored(name: &str, data: &[u8]) -> Self {
            Self {
                name: name.to_string(),
                method: 0,
                payload: data.to_vec(),
                uncompressed_len: data.len(),
                declared_uncompressed: None,
                flags: 0,
            }
        }

        fn deflated(name: &str, data: &[u8]) -> Self {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(data).expect("deflate");
            Self {
                name: name.to_string(),
                method: 8,
                payload: encoder.finish().expect("deflate finish"),
                uncompressed_len: data.len(),
                declared_uncompressed: None,
                flags: 0,
            }
        }

        fn with_declared_size(mut self, size: u32) -> Self {
            self.declared_uncompressed = Some(size);
            self
        }

        fn with_flags(mut self, flags: u16) -> Self {
            self.flags = flags;
            self
        }
    }

    fn build_zip(specs: &[Spec], comment: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for spec in specs {
            let offset = out.len() as u32;
            let uncompressed = spec
                .declared_uncompressed
                .unwrap_or(spec.uncompressed_len as u32);
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes()); // local header
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&spec.flags.to_le_bytes());
            out.extend_from_slice(&spec.method.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // time
            out.extend_from_slice(&0u16.to_le_bytes()); // date
            out.extend_from_slice(&0u32.to_le_bytes()); // crc (never validated)
            out.extend_from_slice(&(spec.payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&uncompressed.to_le_bytes());
            out.extend_from_slice(&(spec.name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra
            out.extend_from_slice(spec.name.as_bytes());
            out.extend_from_slice(&spec.payload);

            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes()); // central header
            central.extend_from_slice(&20u16.to_le_bytes()); // version made by
            central.extend_from_slice(&20u16.to_le_bytes()); // version needed
            central.extend_from_slice(&spec.flags.to_le_bytes());
            central.extend_from_slice(&spec.method.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&(spec.payload.len() as u32).to_le_bytes());
            central.extend_from_slice(&uncompressed.to_le_bytes());
            central.extend_from_slice(&(spec.name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // extra
            central.extend_from_slice(&0u16.to_le_bytes()); // comment
            central.extend_from_slice(&0u16.to_le_bytes()); // disk
            central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(spec.name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        let cd_size = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // disk
        out.extend_from_slice(&0u16.to_le_bytes()); // disk with cd
        out.extend_from_slice(&(specs.len() as u16).to_le_bytes());
        out.extend_from_slice(&(specs.len() as u16).to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&(comment.len() as u16).to_le_bytes());
        out.extend_from_slice(comment);
        out
    }

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let unique = format!(
            "artflow-comic-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default(),
            COUNTER.fetch_add(1, AtomicOrdering::Relaxed)
        );
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    const PAGE_A: &[u8] = b"\x89PNG\r\n\x1a\nfirst-page";
    const PAGE_B: &[u8] = b"\xff\xd8\xff\xe0second-page";

    // —— pure functions ——

    #[test]
    fn sha256_matches_the_nist_vectors_used_for_archive_refs() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // 56 bytes forces the two-block padding path.
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert!(is_archive_ref(&sha256_hex(b"abc")));
        assert!(!is_archive_ref(&sha256_hex(b"abc").to_uppercase()));
        assert!(!is_archive_ref("deadbeef"));
    }

    #[test]
    fn page_mime_mapping_covers_every_supported_extension() {
        assert_eq!(page_mime_for("a/b/page.JPG"), Some("image/jpeg"));
        assert_eq!(page_mime_for("page.jpeg"), Some("image/jpeg"));
        assert_eq!(page_mime_for("page.png"), Some("image/png"));
        assert_eq!(page_mime_for("page.webp"), Some("image/webp"));
        assert_eq!(page_mime_for("page.gif"), Some("image/gif"));
        assert_eq!(page_mime_for("page.AVIF"), Some("image/avif"));
        assert_eq!(page_mime_for("page.bmp"), None);
        assert_eq!(page_mime_for("page"), None);
        assert_eq!(page_mime_for("dir/"), None);
        assert_eq!(page_mime_for("dir.with.dot/page"), None);
    }

    #[test]
    fn metadata_entries_are_not_pages() {
        assert!(is_page_entry("001.png"));
        assert!(!is_page_entry("001.png/"));
        assert!(!is_page_entry("__MACOSX/._001.png"));
        assert!(!is_page_entry(".DS_Store"));
        assert!(!is_page_entry("dir/.DS_Store"));
        assert!(!is_page_entry("readme.txt"));
    }

    #[test]
    fn pages_sort_naturally_not_lexicographically() {
        let mut names = vec!["page10.png", "page2.png", "page1.png"];
        names.sort_by(|left, right| natural_cmp(left, right));
        assert_eq!(names, vec!["page1.png", "page2.png", "page10.png"]);
        assert_eq!(natural_cmp("Page2.png", "page2.png"), Ordering::Equal);
        assert_eq!(natural_cmp("a01.png", "a1.png"), Ordering::Equal);
    }

    // —— ZIP parsing ——

    #[test]
    fn stored_entry_roundtrips_through_the_vault() {
        let zip = build_zip(
            &[
                Spec::stored("001.png", PAGE_A),
                Spec::stored("002.jpg", PAGE_B),
            ],
            b"",
        );
        let pages = list_comic_pages(&zip).expect("pages");
        assert_eq!(
            pages.iter().map(|page| page.name.as_str()).collect::<Vec<_>>(),
            vec!["001.png", "002.jpg"]
        );

        let dir = temp_dir();
        let vault = ComicVault::new(dir.clone());
        let imported = vault.import_archive(&zip, Some("my comic.cbz")).expect("import");
        assert_eq!(imported.reference, sha256_hex(&zip));
        assert_eq!(imported.page_count, 2);
        assert_eq!(imported.byte_size, zip.len());
        assert_eq!(imported.original_name, "my comic.cbz");

        let first = vault.get_page(&imported.reference, 0.0).expect("page 0");
        assert_eq!(first.bytes, PAGE_A);
        assert_eq!(first.mime_type, "image/png");
        let second = vault.get_page(&imported.reference, 1.0).expect("page 1");
        assert_eq!(second.bytes, PAGE_B);
        assert_eq!(second.mime_type, "image/jpeg");
        // Re-import of identical bytes dedupes onto the same file.
        assert_eq!(
            vault
                .import_archive(&zip, None)
                .expect("second import")
                .reference,
            imported.reference
        );
        vault.close_all();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deflate_entries_are_inflated_not_copied() {
        let payload = b"deflate me please, this is compressed ZIP data".repeat(4);
        let zip = build_zip(&[Spec::deflated("001.png", &payload)], b"");
        assert!(zip.len() < payload.len(), "fixture must actually compress");

        let dir = temp_dir();
        let vault = ComicVault::new(dir.clone());
        let imported = vault.import_archive(&zip, None).expect("import");
        let page = vault.get_page(&imported.reference, 0.0).expect("page");
        assert_eq!(page.bytes, payload);
        assert_eq!(page.mime_type, "image/png");
        vault.close_all();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn eocd_lookup_survives_a_trailing_comment() {
        let comment = b"a zip comment that must not hide the EOCD";
        let zip = build_zip(&[Spec::stored("001.png", PAGE_A)], comment);
        let tail_start = zip.len().saturating_sub(EOCD_SCAN_BYTES);
        let eocd = find_eocd(&zip[tail_start..], tail_start as u64).expect("eocd");
        assert_eq!(
            eocd.cd_offset as usize + eocd.cd_size as usize,
            zip.len() - comment.len() - 22
        );
        assert_eq!(list_comic_pages(&zip).expect("pages").len(), 1);
    }

    #[test]
    fn a_comment_that_does_not_end_at_eof_is_not_an_eocd() {
        let mut zip = build_zip(&[Spec::stored("001.png", PAGE_A)], b"ok");
        zip.extend_from_slice(b"extra-bytes-after-eocd");
        let tail_start = zip.len().saturating_sub(EOCD_SCAN_BYTES);
        assert!(find_eocd(&zip[tail_start..], 0).is_err());
    }

    #[test]
    fn non_page_entries_are_filtered_from_the_manifest() {
        let zip = build_zip(
            &[
                Spec::stored("__MACOSX/._001.png", b"junk"),
                Spec::stored("comic/", b""),
                Spec::stored("comic/.DS_Store", b"junk"),
                Spec::stored("comic/readme.txt", b"junk"),
                Spec::stored("comic/001.png", PAGE_A),
                Spec::stored("comic/002.webp", PAGE_B),
            ],
            b"",
        );
        let pages = list_comic_pages(&zip).expect("pages");
        assert_eq!(
            pages.iter().map(|page| page.name.as_str()).collect::<Vec<_>>(),
            vec!["comic/001.png", "comic/002.webp"]
        );
    }

    #[test]
    fn archives_without_pages_and_broken_archives_fail_loudly() {
        let text_only = build_zip(&[Spec::stored("readme.txt", b"hello")], b"");
        assert_eq!(
            list_comic_pages(&text_only).unwrap_err().message(),
            "Comic archives need at least one JPG, PNG, WEBP, GIF, or AVIF page."
        );
        let garbage = vec![0u8; 4096];
        assert_eq!(
            list_comic_pages(&garbage).unwrap_err().message(),
            "Could not read this comic archive."
        );
        // Truncated central directory: claim a CD far past EOF.
        let mut broken = build_zip(&[Spec::stored("001.png", PAGE_A)], b"");
        let eocd_at = broken.len() - 22;
        broken[eocd_at + 16..eocd_at + 20].copy_from_slice(&0xffff_ff00u32.to_le_bytes());
        assert_eq!(
            list_comic_pages(&broken).unwrap_err().message(),
            "comic archive is truncated"
        );
    }

    #[test]
    fn zip64_and_encrypted_archives_are_rejected() {
        let mut zip64 = build_zip(&[Spec::stored("001.png", PAGE_A)], b"");
        let eocd_at = zip64.len() - 22;
        zip64[eocd_at + 12..eocd_at + 16].copy_from_slice(&0xffff_ffffu32.to_le_bytes());
        assert_eq!(
            list_comic_pages(&zip64).unwrap_err().message(),
            "ZIP64 comic archives are not supported."
        );

        let encrypted = build_zip(&[Spec::stored("001.png", PAGE_A).with_flags(0x1)], b"");
        let pages = list_comic_pages(&encrypted).expect("manifest is readable");
        let compressed = &encrypted[30 + "001.png".len()..30 + "001.png".len() + PAGE_A.len()];
        assert_eq!(
            inflate_comic_entry(&pages[0], compressed).unwrap_err().message(),
            "Encrypted comic archives are not supported."
        );
    }

    #[test]
    fn unsupported_compression_is_rejected() {
        let zip = build_zip(&[Spec::stored("001.png", PAGE_A)], b"");
        let mut pages = list_comic_pages(&zip).expect("pages");
        pages[0].method = 12; // bzip2
        assert_eq!(
            inflate_comic_entry(&pages[0], PAGE_A).unwrap_err().message(),
            "Unsupported compression inside the comic archive."
        );
    }

    #[test]
    fn page_count_limit_errors_instead_of_truncating() {
        let specs: Vec<Spec> = (0..MAX_COMIC_PAGE_COUNT + 1)
            .map(|index| Spec::stored(&format!("{index:04}.png"), b"x"))
            .collect();
        let zip = build_zip(&specs, b"");
        assert_eq!(
            list_comic_pages(&zip).unwrap_err().message(),
            "Comic archives are limited to 2000 pages."
        );
    }

    #[test]
    fn entry_count_limit_errors_instead_of_truncating() {
        let specs: Vec<Spec> = (0..MAX_COMIC_ARCHIVE_ENTRIES + 1)
            .map(|index| Spec::stored(&format!("note{index}.txt"), b"x"))
            .collect();
        let zip = build_zip(&specs, b"");
        assert_eq!(
            list_comic_pages(&zip).unwrap_err().message(),
            "Comic archives are limited to 20000 entries."
        );
    }

    #[test]
    fn oversized_page_errors_instead_of_truncating() {
        // Only the manifest is needed; the declared size is what trips the limit.
        let zip = build_zip(
            &[Spec::stored("001.png", b"tiny").with_declared_size((MAX_COMIC_PAGE_BYTES + 1) as u32)],
            b"",
        );
        assert_eq!(
            list_comic_pages(&zip).unwrap_err().message(),
            "Each comic page is limited to 8 MiB."
        );
    }

    #[test]
    fn oversized_archive_errors_instead_of_truncating() {
        let bytes = vec![0u8; MAX_COMIC_ARCHIVE_BYTES + 1];
        let dir = temp_dir();
        let vault = ComicVault::new(dir.clone());
        assert_eq!(
            vault.import_archive(&bytes, None).unwrap_err().message(),
            "Comic files are limited to 512 MiB."
        );
        assert_eq!(
            vault.import_archive(&[], None).unwrap_err().message(),
            "Comic files are empty."
        );
        vault.close_all();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stored_entry_shorter_than_declared_is_an_error() {
        let zip = build_zip(&[Spec::stored("001.png", b"ab").with_declared_size(8)], b"");
        let pages = list_comic_pages(&zip).expect("pages");
        assert_eq!(
            inflate_comic_entry(&pages[0], b"ab").unwrap_err().message(),
            "comic archive is truncated"
        );
    }

    #[test]
    fn deflate_size_mismatch_is_an_error() {
        let payload = b"0123456789".repeat(10);
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&payload).expect("deflate");
        let compressed = encoder.finish().expect("finish");
        let zip = build_zip(
            &[Spec::deflated("001.png", &payload).with_declared_size(50)],
            b"",
        );
        let pages = list_comic_pages(&zip).expect("pages");
        assert_eq!(
            inflate_comic_entry(&pages[0], &compressed).unwrap_err().message(),
            "comic page inflate size mismatch"
        );
    }

    // —— vault behaviour ——

    #[test]
    fn page_index_and_reference_are_validated() {
        let zip = build_zip(&[Spec::stored("001.png", PAGE_A)], b"");
        let dir = temp_dir();
        let vault = ComicVault::new(dir.clone());
        let imported = vault.import_archive(&zip, None).expect("import");
        assert_eq!(
            vault
                .get_page(&imported.reference, 1.0)
                .unwrap_err()
                .message(),
            "comic page index is out of range"
        );
        assert_eq!(
            vault
                .get_page(&imported.reference, 0.5)
                .unwrap_err()
                .message(),
            "comic page index is out of range"
        );
        assert_eq!(
            vault
                .get_page(&imported.reference, -1.0)
                .unwrap_err()
                .message(),
            "comic page index is out of range"
        );
        assert_eq!(
            vault.get_page("../etc/passwd", 0.0).unwrap_err().message(),
            "comic archive reference was rejected"
        );
        assert_eq!(
            vault
                .get_page(&"0".repeat(64), 0.0)
                .unwrap_err()
                .message(),
            "This comic archive is no longer available."
        );
        vault.close_all();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn page_cache_is_bounded_by_its_byte_budget() {
        let page = vec![7u8; 60];
        let zip = build_zip(
            &[
                Spec::stored("001.png", &page),
                Spec::stored("002.png", &page),
                Spec::stored("003.png", &page),
            ],
            b"",
        );
        let dir = temp_dir();
        // Budget fits one page only, so each new page evicts the previous one.
        let vault = ComicVault::with_limits(dir.clone(), 6, 100);
        let imported = vault.import_archive(&zip, None).expect("import");
        for index in 0..3 {
            let page = vault
                .get_page(&imported.reference, index as f64)
                .expect("page");
            assert_eq!(page.bytes.len(), 60);
            assert!(vault.page_cache_bytes() <= 100);
            assert_eq!(vault.lock().page_cache.len(), 1);
        }
        vault.close_all();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_archive_manifests_are_lru_capped() {
        let dir = temp_dir();
        let vault = ComicVault::with_limits(dir.clone(), 2, MAX_PAGE_CACHE_BYTES);
        let mut references = Vec::new();
        for index in 0..3u8 {
            let zip = build_zip(
                &[Spec::stored("001.png", &[index; 8]), Spec::stored("002.png", b"b")],
                b"",
            );
            let imported = vault.import_archive(&zip, None).expect("import");
            vault
                .get_page(&imported.reference, 0.0)
                .expect("warm the archive");
            references.push(imported.reference);
        }
        assert_eq!(vault.open_archive_count(), 2);
        // The evicted manifest is re-parsed on demand instead of failing.
        assert!(vault.get_page(&references[0], 0.0).is_ok());
        vault.close_all();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleted_archives_report_unavailable() {
        let zip = build_zip(&[Spec::stored("001.png", PAGE_A)], b"");
        let dir = temp_dir();
        let vault = ComicVault::new(dir.clone());
        let imported = vault.import_archive(&zip, None).expect("import");
        fs::remove_file(dir.join(format!("{}.cbz", imported.reference))).expect("remove");
        assert_eq!(
            vault
                .get_page(&imported.reference, 0.0)
                .unwrap_err()
                .message(),
            "This comic archive is no longer available."
        );
        vault.close_all();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn closed_vault_refuses_work() {
        let dir = temp_dir();
        let vault = ComicVault::new(dir.clone());
        vault.close_all();
        assert_eq!(
            vault
                .import_archive(b"anything", None)
                .unwrap_err()
                .message(),
            "comic archive controller is closed"
        );
        assert_eq!(
            vault
                .get_page(&"0".repeat(64), 0.0)
                .unwrap_err()
                .message(),
            "comic archive controller is closed"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caller_origin_guard_matches_main() {
        let expected = if cfg!(feature = "custom-protocol") {
            "http://tauri.localhost/"
        } else {
            "http://localhost:4002/"
        };
        assert!(trusted_url(&Url::parse(expected).unwrap()));
        for value in [
            "https://example.com",
            "http://localhost:4003",
            "http://user@localhost:4002",
            "file:///index.html",
        ] {
            if let Ok(url) = Url::parse(value) {
                assert!(!trusted_url(&url), "{value}");
            }
        }
    }

    #[test]
    fn request_decoding_accepts_every_bridge_shape() {
        // Plain JSON array.
        let array: ComicImportRequest =
            serde_json::from_str(r#"{"bytes":[1,2,255],"name":"a.cbz"}"#).expect("array");
        assert_eq!(array.bytes, vec![1, 2, 255]);
        // JSON.stringify of a Uint8Array produces numeric string keys.
        let object: ComicImportRequest =
            serde_json::from_str(r#"{"bytes":{"0":1,"1":2,"2":255}}"#).expect("object");
        assert_eq!(object.bytes, vec![1, 2, 255]);
        // Base64 for large payloads.
        let base64: ComicImportRequest =
            serde_json::from_str(r#"{"bytes":"AQI="}"#).expect("base64");
        assert_eq!(base64.bytes, vec![1, 2]);
        // A missing/null payload is empty, matching `bytes ?? 0` upstream.
        let missing: ComicImportRequest = serde_json::from_str("{}").expect("missing");
        assert!(missing.bytes.is_empty());
        assert!(serde_json::from_str::<ComicImportRequest>(r#"{"bytes":[300]}"#).is_err());
        assert!(serde_json::from_str::<ComicImportRequest>(r#"{"bytes":[1.5]}"#).is_err());

        let page: ComicPageRequest =
            serde_json::from_str(r#"{"ref":"a","index":3}"#).expect("page request");
        assert_eq!(page.reference.as_deref(), Some("a"));
        assert_eq!(page.index, Some(3.0));
    }

    #[test]
    fn reply_shapes_match_the_electron_contract() {
        let reply = ComicImportReply {
            ok: true,
            reference: Some("a".repeat(64)),
            page_names: Some(vec!["001.png".into()]),
            page_count: Some(1),
            byte_size: Some(42),
            original_name: Some("comic.cbz".into()),
            message: None,
        };
        let value = serde_json::to_value(&reply).expect("serialize");
        assert_eq!(value["ok"], serde_json::json!(true));
        assert!(value["ref"].is_string(), "renderer reads `ref`, not `reference`");
        assert!(value.get("message").is_none(), "success must omit the message");
        assert_eq!(value["pageNames"][0], serde_json::json!("001.png"));
        assert_eq!(value["pageCount"], serde_json::json!(1));
        assert_eq!(value["byteSize"], serde_json::json!(42));

        let failure = ComicImportReply::error("nope");
        let value = serde_json::to_value(&failure).expect("serialize");
        assert_eq!(value["ok"], serde_json::json!(false));
        assert_eq!(value["message"], serde_json::json!("nope"));
        assert!(value.get("pageNames").is_none());

        let page = ComicPageReply {
            ok: true,
            bytes: Some(vec![1, 2]),
            mime_type: Some("image/png".into()),
            message: None,
        };
        let value = serde_json::to_value(&page).expect("serialize");
        assert_eq!(value["bytes"], serde_json::json!([1, 2]));
        assert_eq!(value["mimeType"], serde_json::json!("image/png"));
    }
}
