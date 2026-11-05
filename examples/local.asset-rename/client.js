Artflow.modules.definePlugin(function (api) {
  function plan(name, find, replace, prefix, index, numbered) {
    var next = String(name || '');
    if (find) next = next.split(find).join(replace || '');
    if (prefix) next = prefix + next;
    if (numbered) next = next + '-' + String(index + 1);
    return next.trim();
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return String(bytes || 0) + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function Panel(props) {
    var itemsState = React.useState([]);
    var selectedState = React.useState({});
    var findState = React.useState('');
    var replaceState = React.useState('');
    var prefixState = React.useState('');
    var numberedState = React.useState(false);
    var messageState = React.useState('点刷新，读取当前工程的资产显示名。');
    var busyState = React.useState(false);
    var items = itemsState[0];
    var setItems = itemsState[1];
    var selected = selectedState[0];
    var setSelected = selectedState[1];
    var find = findState[0];
    var setFind = findState[1];
    var replace = replaceState[0];
    var setReplace = replaceState[1];
    var prefix = prefixState[0];
    var setPrefix = prefixState[1];
    var numbered = numberedState[0];
    var setNumbered = numberedState[1];
    var message = messageState[0];
    var setMessage = messageState[1];
    var busy = busyState[0];
    var setBusy = busyState[1];

    function refresh() {
      setBusy(true);
      setMessage('');
      props.library.list().then(function (result) {
        setBusy(false);
        if (!result.ok) {
          setMessage(result.message);
          return;
        }
        setItems(result.items);
        setSelected({});
        setMessage(result.items.length ? '已读取 ' + result.items.length + ' 条。一次最多改 40 条。' : '当前工程没有资产。');
      });
    }

    function toggle(id) {
      var next = {};
      var key;
      for (key in selected) next[key] = selected[key];
      next[id] = !next[id];
      setSelected(next);
    }

    function apply() {
      var chosen = items.filter(function (item) { return selected[item.id]; });
      if (!chosen.length) {
        setMessage('先勾选要改名的资产。');
        return;
      }
      if (chosen.length > 40) {
        setMessage('一次最多改 40 条。');
        return;
      }
      var changes = chosen.map(function (item, index) {
        return { id: item.id, name: plan(item.name, find, replace, prefix, index, numbered) };
      });
      if (changes.some(function (change) { return !change.name; })) {
        setMessage('改完的名字不能是空的。');
        return;
      }
      setBusy(true);
      props.library.rename(changes).then(function (result) {
        setBusy(false);
        if (!result.ok) {
          setMessage(result.message);
          return;
        }
        setMessage('已改 ' + result.renamed.length + ' 条' + (result.missing.length ? '，找不到 ' + result.missing.length + ' 条。' : '。'));
        refresh();
      });
    }

    return React.createElement('div', { className: 'space-y-2 text-sm' },
      React.createElement('div', { className: 'text-sm font-medium' }, '批量重命名'),
      React.createElement('p', { className: 'text-xs leading-4 text-neutral-400' }, '只改显示名。文件内容不动。画布上引用同一条资产的卡片会一起改名。'),
      React.createElement('button', {
        type: 'button',
        disabled: busy,
        onClick: refresh,
        className: 'rounded-md bg-violet-500 px-3 py-1 text-white disabled:opacity-50',
      }, '刷新'),
      React.createElement('div', { className: 'max-h-40 space-y-1 overflow-auto' },
        items.map(function (item) {
          return React.createElement('label', { key: item.id, className: 'flex items-center gap-2' },
            React.createElement('input', {
              type: 'checkbox',
              checked: Boolean(selected[item.id]),
              onChange: function () { toggle(item.id); },
            }),
            React.createElement('span', { className: 'min-w-0 flex-1 truncate', title: item.name || item.id }, item.name || item.id),
            React.createElement('span', { className: 'shrink-0 text-neutral-500' }, formatBytes(item.byteSize))
          );
        })
      ),
      React.createElement('input', {
        value: find,
        placeholder: '查找',
        onChange: function (event) { setFind(event.target.value); },
        className: 'w-full rounded bg-black/30 px-2 py-1',
      }),
      React.createElement('input', {
        value: replace,
        placeholder: '替换为',
        onChange: function (event) { setReplace(event.target.value); },
        className: 'w-full rounded bg-black/30 px-2 py-1',
      }),
      React.createElement('input', {
        value: prefix,
        placeholder: '前缀',
        onChange: function (event) { setPrefix(event.target.value); },
        className: 'w-full rounded bg-black/30 px-2 py-1',
      }),
      React.createElement('label', { className: 'flex items-center gap-2 text-neutral-300' },
        React.createElement('input', {
          type: 'checkbox',
          checked: numbered,
          onChange: function (event) { setNumbered(event.target.checked); },
        }),
        '按勾选顺序编号'
      ),
      React.createElement('button', {
        type: 'button',
        disabled: busy,
        onClick: apply,
        className: 'rounded-md bg-white/10 px-3 py-1 disabled:opacity-50',
      }, '重命名所选'),
      message ? React.createElement('p', { className: 'text-xs leading-4 text-amber-200/90' }, message) : null
    );
  }

  api.panels.register({
    id: 'local.asset-rename.panel',
    title: '批量重命名',
    component: Panel,
  });
});
