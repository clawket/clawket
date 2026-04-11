// Output formatting for LLM (json/yaml/md) and humans (table)
// LLM paths are deterministic and cache-friendly.

export function formatOutput(data, format) {
  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'yaml':
      return toYaml(data);
    case 'md':
      return toMarkdown(data);
    case 'table':
    default:
      return toTable(data);
  }
}

function toYaml(data, indent = 0) {
  const pad = '  '.repeat(indent);
  if (data === null || data === undefined) return 'null';
  if (typeof data === 'string') {
    if (data.includes('\n')) {
      return '|\n' + data.split('\n').map(l => pad + '  ' + l).join('\n');
    }
    return needsQuote(data) ? JSON.stringify(data) : data;
  }
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);
  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';
    return data.map(item => {
      if (typeof item === 'object' && item !== null) {
        const entries = Object.entries(item);
        if (entries.length === 0) return pad + '- {}';
        const first = entries[0];
        const rest = entries.slice(1);
        return pad + '- ' + first[0] + ': ' + toYaml(first[1], indent + 1) +
          (rest.length ? '\n' + rest.map(([k, v]) => pad + '  ' + k + ': ' + toYaml(v, indent + 1)).join('\n') : '');
      }
      return pad + '- ' + toYaml(item, indent + 1);
    }).join('\n');
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => {
      const rendered = toYaml(v, indent + 1);
      if (rendered.includes('\n')) {
        return pad + k + ':\n' + rendered;
      }
      return pad + k + ': ' + rendered;
    }).join('\n');
  }
  return String(data);
}

function needsQuote(s) {
  return /^[\s]|[\s]$|[:#&*!|>'"%@`{}[\],]/.test(s) || /^(true|false|null|yes|no|~|\d)/.test(s);
}

function toMarkdown(data) {
  if (Array.isArray(data)) {
    return data.map(item => toMarkdown(item)).join('\n\n---\n\n');
  }
  if (data && typeof data === 'object') {
    const { id, title, body, content, ...rest } = data;
    let out = '';
    if (id) out += `# ${id}`;
    if (title) out += id ? `: ${title}\n` : `# ${title}\n`;
    else if (id) out += '\n';
    for (const [k, v] of Object.entries(rest)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') {
        out += `\n**${k}:**\n\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\`\n`;
      } else {
        out += `- **${k}**: ${v}\n`;
      }
    }
    if (body) out += `\n## body\n\n${body}\n`;
    if (content) out += `\n## content\n\n${content}\n`;
    return out;
  }
  return String(data);
}

function toTable(data) {
  if (!Array.isArray(data)) {
    if (data && typeof data === 'object') {
      const rows = Object.entries(data).map(([k, v]) => [k, stringify(v)]);
      return renderTable(['field', 'value'], rows);
    }
    return String(data);
  }
  if (data.length === 0) return '(empty)';
  const first = data[0];
  if (typeof first !== 'object' || first === null) {
    return data.map(String).join('\n');
  }
  const keys = Object.keys(first);
  const rows = data.map(row => keys.map(k => stringify(row[k])));
  return renderTable(keys, rows);
}

function stringify(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? '').length))
  );
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const fmt = (cells) => '| ' + cells.map((c, i) => (c ?? '').padEnd(widths[i])).join(' | ') + ' |';
  return [sep, fmt(headers), sep, ...rows.map(fmt), sep].join('\n');
}
