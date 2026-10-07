export function toCsv(rows, columns) {
  const cell = (value) => {
    const text = Array.isArray(value) ? value.join('; ') : value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(([, label]) => cell(label)).join(','), ...rows.map((row) => columns.map(([key]) => cell(row[key])).join(','))].join('\r\n');
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter((cells) => cells.some((value) => value.trim()));
  const keys = header.map((key) => key.trim().toLowerCase());
  return body.map((cells) => Object.fromEntries(keys.map((key, index) => [key, (cells[index] || '').trim()])));
}

export function download(filename, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([type.startsWith('text/csv') ? `\uFEFF${content}` : content], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
