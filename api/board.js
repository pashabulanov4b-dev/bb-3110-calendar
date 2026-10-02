// Vercel serverless function: віддає колонки й картки спільної дошки Trello «31.10»
// разом з особистими дошками учасників («31.10 · Ім'я»).
// Потрібні змінні середовища у Vercel: TRELLO_KEY, TRELLO_TOKEN, SITE_PASSWORD.
// Необов'язково: TRELLO_BOARD (за замовчуванням kSYANrdB),
//                TRELLO_PERSONAL_PREFIX (за замовчуванням «31.10 · »).
//
// Як зводяться дані:
// - картки спільної й особистої дошки зіставляються за номером задачі на початку назви («3.5 · …»);
// - задача виконана, якщо її позначили виконаною хоча б на одній дошці;
// - строк — зі спільної дошки, а якщо там його немає — з особистої;
// - рядки опису («Статус:», «Результат:» тощо) — з картки, яку змінювали останньою;
// - картки з особистої дошки без пари на спільній показуються як додаткові задачі цієї людини.
const crypto = require("crypto");

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const COPY_NOTE = /\n*Копія\. Основна картка[\s\S]*$/;
function taskId(name) {
  const m = String(name || "").match(/^\s*(\d+\.\d+)\s*·/);
  return m ? m[1] : null;
}
function isDone(c) {
  return !!(c.dueComplete || c.isComplete || c.complete);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const { TRELLO_KEY, TRELLO_TOKEN, SITE_PASSWORD } = process.env;
  const board = process.env.TRELLO_BOARD || "kSYANrdB";
  const prefix = process.env.TRELLO_PERSONAL_PREFIX || "31.10 · ";

  if (!TRELLO_KEY || !TRELLO_TOKEN || !SITE_PASSWORD) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Сайт не налаштований: у Vercel бракує TRELLO_KEY, TRELLO_TOKEN або SITE_PASSWORD." }));
  }

  const given = req.headers["x-site-password"] || "";
  if (!given || !safeEqual(given, SITE_PASSWORD)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "Невірний пароль." }));
  }

  const auth = "key=" + encodeURIComponent(TRELLO_KEY) + "&token=" + encodeURIComponent(TRELLO_TOKEN);
  const api = (path) => "https://api.trello.com/1" + path + (path.includes("?") ? "&" : "?") + auth;

  async function get(path) {
    const r = await fetch(api(path), { headers: { Accept: "application/json" } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      const err = new Error(body.slice(0, 120));
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  let lists;
  try {
    lists = await get("/boards/" + encodeURIComponent(board) + "/lists?filter=open&fields=name,pos&cards=open&card_fields=name,desc,due,dueComplete,start,closed,shortUrl,url,dateLastActivity");
  } catch (e) {
    res.statusCode = 502;
    const hint = e.status === 401
      ? "Trello не прийняв ключ або токен — перевірте TRELLO_KEY і TRELLO_TOKEN у Vercel."
      : e.status === 404
        ? "Trello не знайшов дошку — перевірте доступ токена до дошки «31.10»."
        : e.status
          ? "Trello відповів помилкою " + e.status + "."
          : "Не вдалося з’єднатися з Trello: " + (e.message || "");
    return res.end(JSON.stringify({ error: hint + (e.status && e.message ? " (" + e.message + ")" : "") }));
  }

  // Особисті дошки: помилка тут не ламає сайт — просто показуємо спільну дошку.
  const warnings = [];
  let personal = [];
  try {
    const boards = await get("/members/me/boards?filter=open&fields=name,shortLink,url");
    const mine = boards.filter((b) => b.name && b.name.startsWith(prefix) && b.shortLink !== board);
    personal = await Promise.all(mine.map(async (b) => {
      try {
        const cards = await get("/boards/" + b.shortLink + "/cards?filter=open&fields=name,desc,due,dueComplete,start,closed,shortUrl,url,dateLastActivity");
        return { owner: b.name.slice(prefix.length).trim(), url: b.url, cards };
      } catch (e) {
        warnings.push("Дошка «" + b.name + "» не прочиталась (" + (e.status || "мережа") + ").");
        return null;
      }
    }));
    personal = personal.filter(Boolean);
  } catch (e) {
    warnings.push("Особисті дошки не прочитались (" + (e.status || "мережа") + ").");
  }

  const out = lists
    .sort((a, b) => a.pos - b.pos)
    .map((l) => ({
      name: l.name,
      cards: (l.cards || []).map((c) => ({
        name: c.name,
        desc: c.desc || "",
        due: c.due || null,
        start: c.start || null,
        dueComplete: !!c.dueComplete,
        complete: isDone(c),
        closed: !!c.closed,
        url: c.shortUrl || c.url,
        doneOn: isDone(c) ? ["спільна"] : [],
        _act: c.dateLastActivity || "",
      })),
    }));

  const byId = new Map();
  out.forEach((l) => l.cards.forEach((c) => { const id = taskId(c.name); if (id && !byId.has(id)) byId.set(id, c); }));

  personal.forEach((p) => {
    p.cards.forEach((pc) => {
      const id = taskId(pc.name);
      const shared = id ? byId.get(id) : null;
      if (shared) {
        shared.personalUrl = pc.shortUrl || pc.url;
        shared.personalBoard = p.owner;
        if (isDone(pc)) {
          shared.complete = true;
          shared.doneOn.push("особиста");
        }
        if (!shared.due && pc.due) shared.due = pc.due;
        if ((pc.dateLastActivity || "") > shared._act) {
          // рядки особистої картки перекривають однойменні рядки спільної, решта лишається
          const d = (pc.desc || "").replace(COPY_NOTE, "").trim();
          if (d) shared.desc = shared.desc + "\n" + d;
        }
        return;
      }
      // Задача, якої немає на спільній дошці — додаємо в колонку людини.
      let list = out.find((l) => l.name === p.owner || l.name.startsWith(p.owner + " ("));
      if (!list) { list = { name: p.owner, cards: [] }; out.push(list); }
      list.cards.push({
        name: pc.name,
        desc: (pc.desc || "").replace(COPY_NOTE, "").trim(),
        due: pc.due || null,
        dueComplete: !!pc.dueComplete,
        complete: isDone(pc),
        closed: !!pc.closed,
        url: pc.shortUrl || pc.url,
        personalOnly: true,
        personalBoard: p.owner,
        doneOn: isDone(pc) ? ["особиста"] : [],
      });
    });
  });

  out.forEach((l) => l.cards.forEach((c) => { delete c._act; }));

  res.statusCode = 200;
  return res.end(JSON.stringify({
    lists: out,
    boards: { shared: board, personal: personal.map((p) => ({ owner: p.owner, url: p.url })) },
    warnings,
    fetchedAt: new Date().toISOString(),
  }));
};
