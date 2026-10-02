// Vercel serverless function: віддає колонки й картки спільної дошки Trello «31.10».
// Потрібні змінні середовища у Vercel: TRELLO_KEY, TRELLO_TOKEN, SITE_PASSWORD.
// TRELLO_BOARD — необов'язково (за замовчуванням kSYANrdB).
const crypto = require("crypto");

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const { TRELLO_KEY, TRELLO_TOKEN, SITE_PASSWORD } = process.env;
  const board = process.env.TRELLO_BOARD || "kSYANrdB";

  if (!TRELLO_KEY || !TRELLO_TOKEN || !SITE_PASSWORD) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Сайт не налаштований: у Vercel бракує TRELLO_KEY, TRELLO_TOKEN або SITE_PASSWORD." }));
  }

  const given = req.headers["x-site-password"] || "";
  if (!given || !safeEqual(given, SITE_PASSWORD)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "Невірний пароль." }));
  }

  const url =
    "https://api.trello.com/1/boards/" + encodeURIComponent(board) +
    "/lists?filter=open&fields=name,pos&cards=open&card_fields=all" +
    "&key=" + encodeURIComponent(TRELLO_KEY) + "&token=" + encodeURIComponent(TRELLO_TOKEN);

  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) {
      res.statusCode = 502;
      const hint = r.status === 401
        ? "Trello не прийняв ключ або токен — перевірте TRELLO_KEY і TRELLO_TOKEN у Vercel."
        : r.status === 404
          ? "Trello не знайшов дошку — перевірте доступ токена до дошки «31.10»."
          : "Trello відповів помилкою " + r.status + ".";
      return res.end(JSON.stringify({ error: hint }));
    }
    const lists = await r.json();
    const out = lists
      .sort((a, b) => a.pos - b.pos)
      .map((l) => ({
        name: l.name,
        cards: (l.cards || []).map((c) => ({
          name: c.name,
          desc: c.desc || "",
          due: c.due || null,
          dueComplete: !!c.dueComplete,
          complete: !!(c.dueComplete || c.isComplete || c.complete),
          closed: !!c.closed,
          url: c.shortUrl || c.url,
        })),
      }));
    res.statusCode = 200;
    return res.end(JSON.stringify({ lists: out, fetchedAt: new Date().toISOString() }));
  } catch (e) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: "Не вдалося з’єднатися з Trello." }));
  }
};
