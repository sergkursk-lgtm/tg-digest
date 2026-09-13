/**
 * Telegram message splitting, mirroring `backend/renderer.py`.
 *
 * The browser resends a stored digest straight to the Bot API, and Telegram rejects any
 * message over 4096 characters or with unbalanced markup. The backend splitter is the
 * tested original; this is a deliberate mirror, the same way `tariff.js` mirrors
 * `pricing.py`, and `tests/telegram.test.mjs` holds it to the same invariants.
 */

export const TELEGRAM_MESSAGE_LIMIT = 4096;

const TAG_PATTERN = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;

/** The tag name of a tag string, or null when it is not a tag. */
function tagName(tag) {
  const match = tag.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
  return match ? match[1] : null;
}

/** Split markup into `[isTag, piece]` pairs. */
function pieces(markup) {
  const result = [];
  let position = 0;
  TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = TAG_PATTERN.exec(markup)) !== null) {
    if (match.index > position) {
      result.push([false, markup.slice(position, match.index)]);
    }
    result.push([true, match[0]]);
    position = match.index + match[0].length;
  }
  if (position < markup.length) {
    result.push([false, markup.slice(position)]);
  }
  return result;
}

/** Split a long text run at spaces, keeping the space on the earlier piece. */
export function hardSplit(text, limit) {
  const parts = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf(" ", limit);
    if (cut <= 0) {
      parts.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    } else {
      parts.push(remaining.slice(0, cut + 1));
      remaining = remaining.slice(cut + 1);
    }
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

/**
 * Split Telegram HTML into messages of at most `limit` characters.
 *
 * Tags are closed at the end of each chunk and reopened in the next, so no chunk is ever
 * unbalanced. Losing a space at a cut is avoided deliberately: it would turn "пункт 130"
 * into "пункт130" across a message boundary.
 *
 * @param {string} markup
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitForTelegram(markup, limit = TELEGRAM_MESSAGE_LIMIT) {
  const text = String(markup ?? "");
  if (text.length <= limit) {
    return text ? [text] : [];
  }

  const chunks = [];
  let current = [];
  let currentLength = 0;
  const openTags = [];

  const closeOpenTags = () =>
    [...openTags].reverse().map((tag) => `</${tagName(tag)}>`).join("");

  const flush = () => {
    if (!current.length) {
      return;
    }
    chunks.push(current.join("") + closeOpenTags());
    current = [...openTags];
    currentLength = openTags.reduce((total, tag) => total + tag.length, 0);
  };

  for (const [isTag, piece] of pieces(text)) {
    if (isTag) {
      const name = tagName(piece);
      if (piece.startsWith("</")) {
        for (let index = openTags.length - 1; index >= 0; index -= 1) {
          if (tagName(openTags[index]) === name) {
            openTags.splice(index, 1);
            break;
          }
        }
      } else if (!piece.endsWith("/>")) {
        openTags.push(piece);
      }
    }

    if (currentLength + piece.length > limit - 16 && current.length) {
      flush();
    }

    if (!isTag && piece.length > limit - 32) {
      for (const part of hardSplit(piece, limit - 32)) {
        if (currentLength + part.length > limit - 16 && current.length) {
          flush();
        }
        current.push(part);
        currentLength += part.length;
      }
      continue;
    }

    current.push(piece);
    currentLength += piece.length;
  }

  if (current.length) {
    chunks.push(current.join("") + closeOpenTags());
  }
  return chunks.filter((chunk) => chunk.trim());
}

/** Telegram API root; the Bot API sends `Access-Control-Allow-Origin: *`. */
export const TELEGRAM_API = "https://api.telegram.org";

/** Strip tags and decode the entities our renderer emits. */
export function stripTags(markup) {
  return String(markup ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Raised when Telegram refuses a message. */
export class TelegramSendError extends Error {
  constructor(message) {
    super(message);
    this.name = "TelegramSendError";
  }
}

/**
 * Send a rendered digest to a chat, splitting it as needed.
 *
 * If Telegram rejects the markup, the chunk is resent as plain text: a slightly uglier
 * message beats a silently missing part of the digest.
 *
 * @param {object} options
 * @param {string} options.token bot token
 * @param {string|number} options.chatId
 * @param {string} options.markup Telegram HTML
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.apiUrl]
 * @returns {Promise<number[]>} message ids
 */
export async function sendToBot({
  token,
  chatId,
  markup,
  fetchImpl = fetch,
  apiUrl = TELEGRAM_API,
}) {
  if (!token) {
    throw new TelegramSendError("не задан токен бота");
  }
  if (chatId === undefined || chatId === null || String(chatId).trim() === "") {
    throw new TelegramSendError("не задан chat_id");
  }

  const chunks = splitForTelegram(markup);
  if (!chunks.length) {
    throw new TelegramSendError("отправлять нечего");
  }

  const messageIds = [];
  for (const chunk of chunks) {
    messageIds.push(await postMessage({ token, chatId, chunk, fetchImpl, apiUrl }));
  }
  return messageIds;
}

/** Post one chunk, falling back to plain text when the markup is refused. */
async function postMessage({ token, chatId, chunk, fetchImpl, apiUrl }) {
  const call = async (payload) => {
    const response = await fetchImpl(`${apiUrl}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({ ok: false, description: "нечитаемый ответ" }));
    return { response, body };
  };

  const first = await call({
    chat_id: String(chatId),
    text: chunk,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  if (first.body?.ok) {
    return Number(first.body.result?.message_id ?? 0);
  }

  const description = String(first.body?.description ?? `HTTP ${first.response.status}`);
  if (description.toLowerCase().includes("can't parse entities")) {
    const fallback = await call({
      chat_id: String(chatId),
      text: stripTags(chunk),
      link_preview_options: { is_disabled: true },
    });
    if (fallback.body?.ok) {
      return Number(fallback.body.result?.message_id ?? 0);
    }
    throw new TelegramSendError(String(fallback.body?.description ?? "не удалось отправить"));
  }

  throw new TelegramSendError(description);
}
