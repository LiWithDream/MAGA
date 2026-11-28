/**
 * Pure v2.34+ Conversation & File Drag-to-Composer (`application/context-scope-item-cider`) helpers.
 * Extracted from sidebar-recents.mjs to keep sidebar modules clean and well under the 2,000-line cap.
 */

export function buildCiderConversationPayload(id, title, defaultTitle = 'Conversation') {
  const cleanTitle = String(title || '').trim() || defaultTitle;
  return JSON.stringify({ conversation: { id: String(id || ''), title: cleanTitle } });
}

export function buildCiderFilePayload(absPathOrUri) {
  const raw = String(absPathOrUri || '').trim();
  if (!raw) return '';
  const uri = /^file:\/\//i.test(raw) ? raw : `file://${encodeURI(raw.startsWith('/') ? raw : `/${raw}`)}`;
  return JSON.stringify({ file: { absoluteUri: uri } });
}

export function attachConversationDragTransfer(dt, id, title, defaultTitle = 'Conversation') {
  if (!dt || !id) return false;
  const payload = buildCiderConversationPayload(id, title, defaultTitle);
  try {
    dt.effectAllowed = 'copyMove';
  } catch {}
  try {
    dt.setData('application/context-scope-item-cider', payload);
    return true;
  } catch {
    return false;
  }
}

export function attachFileDragTransfer(dt, absPathOrUri) {
  if (!dt || !absPathOrUri) return false;
  const payload = buildCiderFilePayload(absPathOrUri);
  if (!payload) return false;
  const raw = String(absPathOrUri || '').trim();
  const uri = /^file:\/\//i.test(raw) ? raw : `file://${encodeURI(raw.startsWith('/') ? raw : `/${raw}`)}`;
  try {
    dt.effectAllowed = 'copyMove';
  } catch {}
  try {
    dt.setData('application/context-scope-item-cider', payload);
    dt.setData('application/vnd.code.uri-list', uri);
    dt.setData('text/uri-list', uri);
    return true;
  } catch {
    return false;
  }
}

export function hasDroppedContextPayload(dt) {
  if (!dt) return false;
  const types = Array.from(dt.types || [], (t) => String(t || '').toLowerCase());
  return (
    types.includes('application/context-scope-item-cider') ||
    types.includes('application/vnd.code.uri-list') ||
    types.includes('resourceurls')
  );
}

function makeFileScopeMention(uri) {
  let label = uri.split('/').pop() || uri;
  try {
    label = decodeURIComponent(label);
  } catch {}
  return {
    kind: 'file',
    label,
    scopeItem: {
      $typeName: 'exa.codeium_common_pb.ContextScopeItem',
      scopeItem: {
        case: 'file',
        value: {
          $typeName: 'exa.codeium_common_pb.FileScopeItem',
          absoluteUri: uri,
        },
      },
    },
  };
}

export function extractDroppedContextMentions(dt) {
  if (!dt) return [];
  const out = [];
  let rawCider = '';
  try {
    rawCider = dt.getData('application/context-scope-item-cider') || '';
  } catch {}
  if (rawCider && rawCider.trim()) {
    try {
      const parsed = JSON.parse(rawCider.trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (let entry of arr) {
        if (typeof entry === 'string') {
          try {
            entry = JSON.parse(entry);
          } catch {
            continue;
          }
        }
        if (!entry || typeof entry !== 'object') continue;
        const conv =
          entry.conversation ||
          (entry.scopeItem && entry.scopeItem.case === 'conversation' ? entry.scopeItem.value : null);
        if (conv && conv.id) {
          const label = String(conv.title || '').trim() || conv.id.slice(0, 8);
          out.push({
            kind: 'conversation',
            label,
            scopeItem: {
              $typeName: 'exa.codeium_common_pb.ContextScopeItem',
              scopeItem: {
                case: 'conversation',
                value: {
                  $typeName: 'exa.codeium_common_pb.ConversationScopeItem',
                  id: String(conv.id),
                  title: label,
                  source: String(conv.source || ''),
                },
              },
            },
          });
          continue;
        }
        const fileObj =
          entry.file ||
          entry.fileLineRange ||
          (entry.scopeItem && (entry.scopeItem.case === 'file' || entry.scopeItem.case === 'fileLineRange')
            ? entry.scopeItem.value
            : null);
        if (fileObj && fileObj.absoluteUri) {
          out.push(makeFileScopeMention(String(fileObj.absoluteUri)));
          continue;
        }
        const dirObj =
          entry.directory ||
          (entry.scopeItem && entry.scopeItem.case === 'directory' ? entry.scopeItem.value : null);
        if (dirObj && dirObj.absoluteUri) {
          const uri = String(dirObj.absoluteUri);
          let label = uri.replace(/\/+$/, '').split('/').pop() || uri;
          try {
            label = decodeURIComponent(label);
          } catch {}
          out.push({
            kind: 'directory',
            label,
            scopeItem: {
              $typeName: 'exa.codeium_common_pb.ContextScopeItem',
              scopeItem: {
                case: 'directory',
                value: {
                  $typeName: 'exa.codeium_common_pb.DirectoryScopeItem',
                  absoluteUri: uri,
                },
              },
            },
          });
        }
      }
    } catch {}
  }
  if (out.length) return out;

  let uriList = '';
  try {
    uriList = dt.getData('application/vnd.code.uri-list') || '';
  } catch {}
  if (uriList && uriList.trim()) {
    for (const line of uriList.split(/\r?\n/)) {
      const u = line.trim();
      if (!u || u.startsWith('#') || !/^file:\/\//i.test(u)) continue;
      out.push(makeFileScopeMention(u));
    }
  }
  return out;
}
