import * as pdfjsLib from 'pdfjs-dist';

// Setup pdf.js worker URL dynamically
if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
}

export const isPdfFile = (file: File): boolean => {
    if (!file) return false;
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
};

export interface PdfPageResult {
    pageNumber: number;
    dataUrl: string;
    width: number;
    height: number;
}

export const parsePdfFile = async (file: File): Promise<PdfPageResult[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;
    const results: PdfPageResult[] = [];

    // Render up to first 20 pages if large document
    const maxPages = Math.min(numPages, 20);

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 }); // 2x for sharp retina rendering

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');

        if (ctx) {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            await page.render({
                canvas,
                viewport,
            }).promise;

            results.push({
                pageNumber: pageNum,
                dataUrl: canvas.toDataURL('image/png'),
                width: Math.round(viewport.width / 2),
                height: Math.round(viewport.height / 2),
            });
        }
    }

    return results;
};
