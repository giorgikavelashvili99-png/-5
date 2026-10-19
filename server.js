// AI ჩატის სერვერი — Google Gemini API (უფასო დონე). გასაღები ინახება მხოლოდ აქ
// (გარემოს ცვლადში), ბრაუზერში არასდროს ჩანს. დამოკიდებულებები არ სჭირდება (Node 18+).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ""; // მაგ: https://moonfull4k.xyz (თუ Index.html სხვაგან ჰოსტდება)
const MAX_TOKENS = 8192;          // მოდელის ფიქრიც ამ ლიმიტში ითვლება, ამიტომ დიდი მარაგი გვჭირდება
const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;          // ერთი შეტყობინების მაქსიმალური სიგრძე
const RATE_LIMIT = 20;           // მოთხოვნა ...
const RATE_WINDOW_MS = 60_000;   // ... წუთში, ერთ IP-ზე

// სარეზერვო მოდელები: თუ მთავარის უფასო ლიმიტი ამოიწურა, სერვერი თავისით გადადის მსუბუქ მოდელებზე
const FALLBACKS = (process.env.GEMINI_FALLBACKS ||
  "gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-latest,gemini-flash-lite-latest")
  .split(",").map(s => s.trim()).filter(Boolean);
const MODELS = [MODEL, ...FALLBACKS.filter(m => m !== MODEL)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEBUG = process.env.GEMINI_DEBUG === "1"; // 1 = ტექნიკური მიზეზიც გამოჩნდება ჩატში (მხოლოდ გამართვისთვის)
function errMsg(text) {
  try { const j = JSON.parse(text); if (j.error && j.error.message) return String(j.error.message).slice(0, 220); } catch {}
  return String(text || "").slice(0, 220);
}
function retryDelayMs(text) {
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(text || "");
  return m ? Math.round(parseFloat(m[1]) * 1000) : 0;
}
const SEARCH = process.env.GEMINI_SEARCH !== "0"; // Google ძებნა ახალი ინფორმაციისთვის (გამოსართავად: GEMINI_SEARCH=0)

// მოდელს ყოველ მოთხოვნაზე ვეუბნებით დღევანდელ თარიღს, რომ "2024 წელზე" არ დარჩეს
function systemPrompt(tz) {
  let zone = "Asia/Tbilisi";
  if (typeof tz === "string" && tz.length < 60) {
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); zone = tz; } catch {}
  }
  const now = new Date();
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now);
  const year = iso.slice(0, 4);
  return [
    "შენ ხარ MOON AI (ვერსია MOON 1.0), მშვიდი და გასაგები ასისტენტი. თუ გკითხავენ, ვინ შეგქმნა ან რომელ მოდელს ეფუძნები, უპასუხე, რომ MOON AI ხარ და ტექნიკური დეტალები არ იცი. არასოდეს დაასახელო სხვა კომპანია ან მოდელი და არაფერი მოიგონო",
    "დღევანდელი თარიღია " + iso + " (" + weekday + "), დროის სარტყელი: " + zone + ". ახლა " + year + " წელია. არასოდეს თქვა, რომ 2024 ან უფრო ადრეა. შენი სწავლების მონაცემები ძველია, ამიტომ ახალ ამბებზე, ფასებზე, ვერსიებზე და ყველაფერზე, რაც შეიძლებოდა შეცვლილიყო, გამოიყენე ძებნა. თუ ახალი ინფორმაცია ვერ დაადასტურე, პირდაპირ თქვი, რომ ის შეიძლება მოძველებული იყოს.",
    "უპასუხე იმ ენაზე, რომლითაც მომხმარებელი წერს (ნაგულისხმევად ქართულად). იყავი ზუსტი, მკაფიო და არაზედმეტად ვრცელი. ქართული დაწერე გრამატიკულად სწორად და ბუნებრივად, სიტყვა-სიტყვით თარგმანის გარეშე.",
    "სტილი: პასუხი დაწერე დასრულებულად და ლამაზად ჩამოყალიბებულად: ჯერ პირდაპირ და მოკლედ უპასუხე კითხვას, მერე საჭიროებისას დაამატე დეტალები. გრძელ პასუხებში გამოიყენე მოკლე სათაურები (## ...), სიები, **მუქი** მთავარი სიტყვები და შედარებისას ცხრილი. ზედმეტი შესავალი და გამეორება არ გამოიყენო.",
    "ფაილები და კოდი: თუ მომხმარებელი გვერდს, აპლიკაციას, სკრიპტს ან ფაილს ითხოვს (ან კოდი 15 ხაზზე გრძელია), მთლიანი კოდი ჩასვი ერთ ბლოკში და ფაილის სახელი ღობეზე მიუთითე, მაგალითად ```html Index.html ან ```python main.py. ფაილი ნაწილებად არ დაყო. ბლოკის გარეთ ორ-სამ წინადადებაში ახსენი, რას აკეთებს. კოდი ტექსტში აღარ გაიმეორო. მოკლე ილუსტრაციის კოდს (15 ხაზამდე) ფაილის სახელი არ სჭირდება.",
    "შენ შეგიძლია სურათების დახატვაც: ამისთვის მომხმარებელმა უნდა დააჭიროს ველის მარცხენა მხარეს სურათის ღილაკს ან დაწეროს „დამიხატე ...“. არასოდეს თქვა, რომ სურათის გენერირება შეუძლებელია.",
    "ფორმატი: Markdown. არ გამოიყენო LaTeX და $ ფორმულები. ისრებისთვის გამოიყენე → სიმბოლო."
  ].join("\n");
}

// ---------- სარეზერვო მომწოდებლები (Llama / Qwen და სხვ.) ----------
// Gemini-ს ლიმიტი რომ ამოიწურება, სერვერი თავისით გადადის შემდეგზე. გასაღები საჭიროა მხოლოდ იმისთვის, რომელსაც ჩართავ.
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const list = (v, d) => (v || d).split(",").map(x => x.trim()).filter(Boolean);
// Ollama: ღრუბლოვანი (ollama.com + OLLAMA_API_KEY) ან შენი საკუთარი კომპიუტერი (OLLAMA_URL=https://შენი-მისამართი/v1/chat/completions)
const OLLAMA_KEY = process.env.OLLAMA_API_KEY || "";
const OLLAMA_URL = process.env.OLLAMA_URL || (OLLAMA_KEY ? "https://ollama.com/v1/chat/completions" : "");
let ollamaCache = { at: 0, models: [] };
async function ollamaModels() {
  const fixed = list(process.env.OLLAMA_MODELS, "");
  if (fixed.length) return fixed;
  if (Date.now() - ollamaCache.at < 3600_000 && ollamaCache.models.length) return ollamaCache.models;
  try {
    const base = OLLAMA_URL.replace(/\/v1\/chat\/completions.*$/, "");
    const r = await fetch(base + "/api/tags", { headers: OLLAMA_KEY ? { authorization: "Bearer " + OLLAMA_KEY } : {} });
    const j = await r.json();
    const names = (j.models || []).map(m => m.name || m.model).filter(Boolean);
    const size = n => { const m = /(\d+(?:\.\d+)?)b/i.exec(n); return m ? parseFloat(m[1]) : 0; };
    const big = arr => arr.slice().sort((a, b) => size(b) - size(a)); // დიდი მოდელი ქართულს უკეთ წერს
    const pick = [...big(names.filter(n => /qwen|llama/i.test(n))), ...big(names)].filter((n, i, a) => a.indexOf(n) === i).slice(0, 3);
    if (pick.length) ollamaCache = { at: Date.now(), models: pick };
  } catch (e) { note("ollama-tags", 0); }
  return ollamaCache.models;
}
// OpenAI (ChatGPT-ის მოდელები): ფასიანი API გასაღები (platform.openai.com). ყველაზე იაფი მოდელი gpt-6-luna დაახლოებით $0.10 / $0.50 ჯდება 1 მლნ ტოკენზე
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const PROVIDERS = [
  { name: "openai", url: process.env.OPENAI_URL || "https://api.openai.com/v1/chat/completions", key: OPENAI_KEY,
    models: list(process.env.OPENAI_MODELS, "gpt-6-luna") },
  { name: "groq", url: process.env.GROQ_URL || "https://api.groq.com/openai/v1/chat/completions", key: GROQ_KEY,
    models: list(process.env.GROQ_MODELS, "openai/gpt-oss-120b,llama-3.3-70b-versatile,qwen/qwen3.8-27b,llama-3.1-8b-instant") },
  { name: "ollama", url: OLLAMA_URL, key: OLLAMA_KEY || (OLLAMA_URL ? "local" : ""), getModels: ollamaModels },
  { name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", key: OPENROUTER_KEY,
    models: list(process.env.OPENROUTER_MODELS, "nvidia/nemotron-3.5-super-vl:free,xingchen-agi/xing4.0-29b-a4b:free") }
].filter(p => p.key);
// რიგი იცვლება ცვლადით, მაგ: FALLBACK_ORDER=ollama,groq,openrouter (პირველი ის, ვინც ქართულს უკეთ წერს)
const ORDER = list(process.env.FALLBACK_ORDER, "openai,groq,ollama,openrouter");
PROVIDERS.sort((x, y) => { const i = ORDER.indexOf(x.name), j = ORDER.indexOf(y.name); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
const HAS_ANY_KEY = () => !!API_KEY || PROVIDERS.length > 0;
// მოკლე ინსტრუქცია სარეზერვო (პატარა) მოდელებისთვის: გრძელი ინსტრუქცია მათ ბნელდებათ, ამიტომ მხოლოდ მთავარი
function fallbackSystem(tz) {
  let zone = "Asia/Tbilisi";
  if (typeof tz === "string" && tz.length < 60) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); zone = tz; } catch {} }
  const now = new Date();
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now);
  return [
    "შენ ხარ MOON AI, ქართულენოვანი ასისტენტი. სხვა კომპანიას ან მოდელს არ ახსენებ.",
    "დღეს არის " + iso + " (" + weekday + "), ანუ " + iso.slice(0, 4) + " წელი.",
    "უპასუხე მომხმარებლის კითხვას პირდაპირ და მოკლედ, იმ ენაზე, რომლითაც გწერს (ნაგულისხმევად ქართულად). თუ კითხვა მართლა გაუგებარია, დასვი ერთი მოკლე დამაზუსტებელი შეკითხვა.",
    "ქართული დაწერე მარტივი, გრამატიკულად სწორი წინადადებებით, ყველაზე გავრცელებული სიტყვებით. რიცხვის შემდეგ მრავლობითს არ წერენ („ხუთი წიგნი“). გარდამავალი ზმნის წყვეტილში ქვემდებარე მოთხრობითშია („კაცმა დაწერა“).",
    "ფაქტი, ანდაზა, ციტატა, თარიღი ან სახელი არასოდეს მოიგონო. თუ არ იცი, თქვი: „ზუსტად არ ვიცი“.",
    "ფორმატი: Markdown. კოდი ჩასვი ერთ ბლოკში ფაილის სახელით, მაგალითად ```html Index.html."
  ].join("\n");
}
const NO_SEARCH_NOTE = "\nინტერნეტი ამ რეჟიმში არ გაქვს. თუ ახალ ამბებს ან ცვალებად ფაქტს გეკითხებიან, პირდაპირ თქვი, რომ ვერ ამოწმებ.";

// ძებნა სარეზერვო მოდელებისთვის (Ollama web_search, იგივე OLLAMA_API_KEY). ფაქტებს ამით ვამყარებთ და მოგონებას ვამცირებთ
const SEARCH_URL = process.env.OLLAMA_SEARCH_URL || "https://ollama.com/api/web_search";
async function searchContext(messages, signal) {
  if (!OLLAMA_KEY || process.env.FALLBACK_SEARCH === "0") return "";
  const last = [...messages].reverse().find(m => m.role === "user");
  let q = last ? last.content.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (NEWS_RE.test(q)) q += " " + new Date().getFullYear() + " ახალი ამბები";
  if (q.length < 12 || /^(გამარჯობა|გაუმარჯოს|ჰაი|hi|hello|hey|სალამი)\b/i.test(q) && q.length < 25) return "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    const r = await fetch(SEARCH_URL, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + OLLAMA_KEY },
      body: JSON.stringify({ query: q, max_results: 5 })
    });
    clearTimeout(t);
    if (!r.ok) { note("search", r.status); return ""; }
    const j = await r.json();
    const items = (j.results || []).slice(0, 5).map((x, i) => (i + 1) + ") " + String(x.title || "").slice(0, 120) + " — " + String(x.content || "").replace(/\s+/g, " ").slice(0, 500) + " (" + String(x.url || "").slice(0, 120) + ")");
    return items.length ? "\n\nინტერნეტ-ძებნის შედეგები (ფაქტებისთვის გამოიყენე ისინი; თუ პასუხი მათში არ წერია, ეს პირდაპირ თქვი და ნუ მოიგონებ):\n" + items.join("\n") : "";
  } catch (e) { note("search", 0); return ""; }
}

// კითხვები, სადაც პატარა მოდელები ყველაზე ხშირად გამოგონებას იწყებენ: ანდაზა, ციტატა, ლექსი, გამოთქმა...
const NEWS_RE = /რა\s?ხდება|რას აკეთებს|ახალი ამბ|ამბები|უკანასკნელი ამბ|ბოლო ამბ|დღეს რა|რა ხდება|ამინდ|კურსი|ფასი|ვინ მოიგო|ახლა.*(?:ვინ|რა|რამდენ)|news|latest|today/i;
const NEWS_CANNED = "ახალი ამბების ინტერნეტით შემოწმება ამ რეჟიმში ახლა ვერ ხერხდება და არ მინდა დაუზუსტებელი ინფორმაცია გითხრა. სცადე რამდენიმე წუთში ან ჰკითხე უფრო კონკრეტულად, მაგალითად: „რა მოხდა საფრანგეთში წელს არჩევნებთან დაკავშირებით“.";
const QUOTE_RE = /ანდაზ|გამოცანა|ციტატ|აფორიზმ|ლექსი|ლექსს|გამონათქვამ|პოემ|ზღაპარი.*ტექსტ|proverb|quote|poem/i;
// რეალური ქართული ანდაზები (წყარო: „ქართული და ფრანგული ანდაზები“, საქართველოს პარლამენტის ეროვნული ბიბლიოთეკის ციფრული კრებული).
// ისინი სიტყვა-სიტყვით არის გადმოწერილი; სარეზერვო მოდელი ანდაზის კითხვაზე აქედან პასუხობს და არაფერს თხზავს.
const PROVERBS = [
  "თევზი თავიდან ყროლდება.",
  "ვისაც თევზი უნდა, ფეხები სველი უნდა ჰქონდეს.",
  "მოთმინება სამოთხის გასაღებიაო.",
  "მარტო ლოცვით სამოთხეში არ შეისვლებაო.",
  "დიდ აღმართს დიდი დაღმართიც მოსდევსო.",
  "ყეფითა და ყივილით სოფელი ვერ შენდებაო.",
  "ვისაც თორნე ცხელი აქვს, პურსაც ის გამოაცხობსო.",
  "სახით მღვდელი, საქმით მგელი.",
  "სიკეთე ქენ – ქვაზე დადე, გამოივლი, წინ დაგხვდება.",
  "ყვავსაც თავისი ბახალა მოსწონსო.",
  "ბაყაყი ხალიჩაზე დააბრძანეს, ისკუპა და ისევ გუბეში ჩახტაო.",
  "თაგვს ბუმბულში აწვენდნენ და თაგვი სოროში გარბოდაო.",
  "ვინც რა უნდა თქვასო, წისქვილმა კი ფქვასო.",
  "ფარა რომ მობრუნდება, კოჭლი ცხვარი წინ მოექცევაო.",
  "ძაღლი ახსენე, ჯოხი ხელში დაიკავეო.",
  "ხერხი სჯობია ღონესა, თუ კაცი მოიგონებსა.",
  "კაცი რასაც აქ სიკეთეს იქს, იქ, საიქიოს, დახვდება.",
  "არა გყავდეს მოახლეო, თავი მოიმოახლეო.",
  "სანთელ-საკმეველი თავის გზას არ დაკარგავსო.",
  "თუ ღმერთი მწყალობს, ეშმაკი რას დამაკლებსო."
];
function proverbAnswer(q) {
  const m = /(\d{1,2})/.exec(q);
  const n = Math.max(1, Math.min(10, m ? parseInt(m[1], 10) : 3));
  const pool = PROVERBS.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return "ქართული ხალხური ანდაზები:\n\n" + pool.slice(0, n).map(x => "- „" + x.replace(/[.]$/, "") + "“").join("\n") +
    "\n\nეს ანდაზები ქართული ანდაზების ბიბლიოთეკური კრებულიდან არის გადმოწერილი. მათი მნიშვნელობა, თუ გინდა, ცალკე ამიხსნა.";
}
const CANNED = "ამ კითხვაზე ახლა დადასტურებულ ქართულ ტექსტებს ვერ ვპოულობ და არ მინდა გამოგონილი გაჩვენო. სცადე რამდენიმე წუთში ან დაწერე უფრო კონკრეტულად, მაგალითად: „მეგობრობაზე ქართული ანდაზა“.";

async function openAiChain(system, messages, signal) {
  let extra = await searchContext(messages, signal);
  const lastU = [...messages].reverse().find(m => m.role === "user");
  if (lastU && NEWS_RE.test(lastU.content) && !extra) return { canned: NEWS_CANNED }; // ძებნის გარეშე ახალ ამბებზე არ ვპასუხობთ
  if (lastU && /ანდაზ|proverb/i.test(lastU.content)) return { canned: proverbAnswer(lastU.content) }; // ნამდვილი ანდაზები ბაზიდან
  if (lastU && QUOTE_RE.test(lastU.content)) {
    if (!extra) return { canned: CANNED };            // ძებნის გარეშე ასეთ კითხვებზე მოდელს არ ვუშვებთ: გამოგონებას გამოიწვევდა
    extra += "\nმხოლოდ ის ტექსტები ამოწერე, რომლებიც ზუსტად ამ შედეგებშია, სიტყვა-სიტყვით. საკუთარი ტექსტი არ დაამატო და არაფერი გადააკეთო. თუ ზუსტად სამგვარი მოიძებნა, მხოლოდ მათ დაწერე.";
  }
  for (const prov of PROVIDERS) {
    for (const model of (prov.getModels ? await prov.getModels() : prov.models)) {
      try {
        const r = await fetch(prov.url, {
          method: "POST", signal,
          headers: { "content-type": "application/json", ...(prov.key !== "local" ? { authorization: "Bearer " + prov.key } : {}) },
          body: JSON.stringify({
            model, stream: true, ...(prov.name === "openai" ? { max_completion_tokens: 4096 } : { max_tokens: 4096, temperature: 0.3 }), // დაბალი ტემპერატურა = ნაკლები მოგონილი სიტყვა
            messages: [{ role: "system", content: system + (extra ? "" : NO_SEARCH_NOTE) + extra }, ...messages.map(m => ({ role: m.role, content: m.content }))]
          })
        });
        if (r.ok && r.body) return { r, prov: prov.name, model };
        console.error(prov.name, model, r.status, (await r.text().catch(() => "")).slice(0, 400)); note(prov.name, r.status);
      } catch (e) { if (signal.aborted) return null; console.error(prov.name, model, "კავშირის შეცდომა"); }
    }
  }
  return null;
}

// OpenAI-ფორმატის ნაკადს ვაქცევთ Index.html-ის ფორმატად; <think>...</think> ტექსტს ვმალავთ
async function pipeOpenAi(res, alt, ctrl) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
  let emitted = false, inThink = false, pend = "";
  const out = t => { if (!t) return; emitted = true; res.write("data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } }) + "\n\n"); };
  const feed = t => {
    pend += t;
    for (;;) {
      if (inThink) {
        const i = pend.indexOf("</think>");
        if (i < 0) { pend = pend.slice(-8); return; }
        pend = pend.slice(i + 8).replace(/^\s+/, ""); inThink = false;
      } else {
        const i = pend.indexOf("<think>");
        if (i >= 0) { out(pend.slice(0, i)); pend = pend.slice(i + 7); inThink = true; continue; }
        const keep = /<(t(h(i(n(k)?)?)?)?)?$/.exec(pend);
        const cut = keep ? pend.length - keep[0].length : pend.length;
        out(pend.slice(0, cut)); pend = pend.slice(cut); return;
      }
    }
  };
  try {
    const dec = new TextDecoder(); let buf = "";
    const handle = ln => {
      if (!ln.startsWith("data:")) return;
      const d = ln.slice(5).trim();
      if (!d || d === "[DONE]") return;
      try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (typeof t === "string") feed(t); } catch {}
    };
    for await (const chunk of alt.r.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(handle);
    }
    handle(buf);
    if (!inThink && pend) out(pend);
  } catch {}
  if (!emitted && !ctrl.signal.aborted) {
    res.write("data: " + JSON.stringify({ type: "error", message: "პასუხი ვერ მივიღე. სცადე თავიდან." }) + "\n\n");
  }
  res.end();
}

// ბოლო შეცდომები (მხოლოდ სტატუსის კოდი), რომ /health-ზე დიაგნოსტიკა გამოჩნდეს; გასაღებები და ტექსტი აქ არ ხვდება
const recent = [];
let lastUsed = "";
const note = (who, status, msg) => { recent.push({ who, status, ...(msg ? { msg } : {}), at: new Date().toISOString() }); if (recent.length > 8) recent.shift(); };

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    if (!arr.some(t => now - t < RATE_WINDOW_MS)) hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

function cors(res, req) {
  if (ALLOWED_ORIGIN && req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    const content = m.content.slice(0, MAX_CHARS);
    if (!content.trim()) continue;
    out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") return null;
  return out;
}


// ---------- სურათის სარეზერვო გზა (OpenAI-ს სურათის მოდელი) ----------
// Puter-ის ბალანსის ამოწურვის შემდეგ სურათს ეს ხატავს. ფასიანია, ამიტომ დღიური ლიმიტი გვაქვს (IMAGE_DAILY_LIMIT, ნაგულისხმევი 40).
const IMG_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const OPENAI_BASE = process.env.OPENAI_BASE || "https://api.openai.com/v1";
const IMG_MAX = parseInt(process.env.IMAGE_DAILY_LIMIT || "40", 10);
let imgDay = "", imgCount = 0;
const IMG_SYS = "You write ONE detailed, vivid English prompt for a text-to-image model from the user's request. Keep the subject, style, mood, colors, composition and format. For realistic photos describe camera, lighting and lens. Output ONLY the prompt, no quotes, at most 120 words.";
const IMG_SYS_EDIT = "You turn the user's request into ONE concise English instruction for an image model that receives the user's own photo(s). Keep the people, objects and composition unless asked to change them. Describe only the desired change or style. Output ONLY the instruction, no quotes, at most 80 words.";

async function imagePrompt(prompt, edit, signal) {
  if (!/[Ⴀ-ჿ]/.test(prompt)) return prompt;          // უკვე ინგლისურია
  try {
    const m = list(process.env.OPENAI_MODELS, "gpt-6-luna")[0];
    const r = await fetch(OPENAI_BASE + "/chat/completions", {
      method: "POST", signal: AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + OPENAI_KEY },
      body: JSON.stringify({ model: m, max_completion_tokens: 400, messages: [{ role: "system", content: edit ? IMG_SYS_EDIT : IMG_SYS }, { role: "user", content: prompt }] })
    });
    if (!r.ok) throw new Error("p" + r.status);
    const j = await r.json();
    const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof t === "string" && t.trim()) return t.trim().replace(/^["“]|["”]$/g, "").slice(0, 1200);
  } catch (e) { note("img-prompt", 0); }
  return prompt;
}

async function image(req, res) {
  cors(res, req);
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (!OPENAI_KEY) return json(res, 501, { error: "not configured" });
  if (limited(ip)) return json(res, 429, { error: "ძალიან ბევრი მოთხოვნაა. ერთი წუთით მოიცადე." });
  let body;
  try { body = JSON.parse(await readBody(req, 8_000_000)); }
  catch { return json(res, 400, { error: "არასწორი მოთხოვნა." }); }
  const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 2000).trim() : "";
  if (!prompt) return json(res, 400, { error: "ცარიელი მოთხოვნა." });
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, 4).filter(x => typeof x === "string" && /^data:image\/(png|jpe?g|webp);base64,/i.test(x)) : [];
  const day = new Date().toISOString().slice(0, 10);
  if (day !== imgDay) { imgDay = day; imgCount = 0; }
  if (imgCount >= IMG_MAX) return json(res, 429, { error: "daily" });
  imgCount++;
  const quality = ["low", "medium", "high"].includes(body.quality) ? body.quality : "low";
  const rt = body.ratio && body.ratio.w && body.ratio.h ? body.ratio.w / body.ratio.h : 1;
  const size = rt > 1.2 ? "1536x1024" : rt < 0.83 ? "1024x1536" : "1024x1024";
  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());
  try {
    const p = await imagePrompt(prompt, photos.length > 0, ctrl.signal);
    let r;
    const signal = AbortSignal.any ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(170000)]) : ctrl.signal;
    if (photos.length) {
      const fd = new FormData();
      fd.append("model", IMG_MODEL); fd.append("prompt", p); fd.append("quality", quality); fd.append("size", size);
      photos.forEach((d, i) => {
        const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(d);
        const ext = /png/.test(m[1]) ? "png" : /webp/.test(m[1]) ? "webp" : "jpg";
        fd.append("image[]", new Blob([Buffer.from(m[2], "base64")], { type: m[1] }), "photo" + i + "." + ext);
      });
      r = await fetch(OPENAI_BASE + "/images/edits", { method: "POST", signal, headers: { authorization: "Bearer " + OPENAI_KEY }, body: fd });
    } else {
      r = await fetch(OPENAI_BASE + "/images/generations", {
        method: "POST", signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + OPENAI_KEY },
        body: JSON.stringify({ model: IMG_MODEL, prompt: p, quality, size, n: 1 })
      });
    }
    if (!r.ok) {
      let em = "";
      try { const ej = await r.json(); em = String((ej && ej.error && (ej.error.code || ej.error.message)) || "").replace(/sk-[\w-]+/g, "sk-***").slice(0, 160); } catch {}
      note("image-" + r.status, r.status, em);
      imgCount = Math.max(0, imgCount - 1);
      return json(res, 502, { error: "image failed", status: r.status });
    }
    const j = await r.json();
    const d = j && j.data && j.data[0];
    const out = d && d.b64_json ? "data:image/png;base64," + d.b64_json : (d && d.url) || "";
    if (!out) { imgCount = Math.max(0, imgCount - 1); return json(res, 502, { error: "empty" }); }
    lastUsed = "image:" + IMG_MODEL;
    return json(res, 200, { image: out });
  } catch (e) {
    imgCount = Math.max(0, imgCount - 1);
    if (!res.headersSent) return json(res, 502, { error: "image failed" });
  }
}

// ---------- საიტის ცოდნა: ცოცხალი index.html ----------
// MOON AI საიტში ჩაშენებულია. კითხვისას სერვერი საიტის მიმდინარე index.html-ს კითხულობს (ცვლილების შემოწმება ETag-ით, ამიტომ იაფია),
// ყოფს ნაწილებად, BM25-ით პოულობს კითხვასთან დაკავშირებულ ამონარიდებს და ხაზების ნომრებით აბრუნებს. 2 მბ-იან ფაილს მთლიანად მოდელს ვერ მივცემთ.
const SITE_URL = process.env.SITE_URL || "https://moonfull4k.xyz/";
let siteIdx = null, siteLoading = null;
const BASE64_RE = /data:[a-z0-9\/+.\-]+;base64,[A-Za-z0-9+\/=]{60,}/gi;
const tok = str => (String(str).toLowerCase().match(/[\p{L}\p{N}_$]{2,}/gu) || []).map(w => /[Ⴀ-ჿ]/.test(w) ? w.slice(0, 5) : w);

function buildSite(html, etag) {
  const raw = html.split(/\r?\n/);
  const chunks = [];
  let buf = [], len = 0, start = 1;
  const flush = end => { if (buf.length) chunks.push({ s: start, e: end, text: buf.join("\n") }); buf = []; len = 0; };
  for (let i = 0; i < raw.length; i++) {
    let ln = raw[i].replace(BASE64_RE, "data:…base64…");
    if (ln.length > 2500) ln = ln.slice(0, 2500) + " …[ხაზი მოკლებულია, სულ " + raw[i].length + " სიმბოლო]";
    if (len + ln.length > 1800 && buf.length) { flush(i); start = i + 1; }
    buf.push(ln); len += ln.length + 1;
  }
  flush(raw.length);
  const df = new Map(); let total = 0;
  for (const c of chunks) {
    const tf = new Map();
    for (const t of tok(c.text)) tf.set(t, (tf.get(t) || 0) + 1);
    c.tf = tf; c.len = c.text.length; total += c.len;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const uniq = (re, g = 1) => [...new Set([...html.matchAll(re)].map(m => m[g]))];
  const title = (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || "";
  const views = uniq(/data-view="([\w-]+)"/g);
  const nav = uniq(/data-hz-go="([\w-]+)"/g);
  const hosts = uniq(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi).filter(h => !/w3\.org|googleapis|gstatic|schema\.org|fonts\./i.test(h)).slice(0, 25);
  const ids = uniq(/\bid="([A-Za-z][\w-]*(?:Panel|View|Modal|Box|Section))"/g).slice(0, 60);
  const fns = uniq(/\bfunction\s+([A-Za-z_$][\w$]{3,})\s*\(/g).slice(0, 160);
  const outline = [
    "ფაილი: index.html, " + raw.length + " ხაზი, " + Math.round(html.length / 1024) + " კბ. სათაური: " + title,
    "გვერდები (data-view): " + views.join(", "),
    "ზედა ნავიგაცია (data-hz-go): " + nav.join(", "),
    "გარე სერვისები: " + hosts.join(", "),
    "მთავარი პანელები/ფანჯრები (id): " + ids.join(", "),
    "ფუნქციები (ნაწილი): " + fns.join(", ")
  ].join("\n").slice(0, 4200);
  const hash = (etag || "").replace(/[^\w]/g, "").slice(-10) || String(html.length);
  return { etag, hash, raw, chunks, df, avg: total / Math.max(1, chunks.length), outline, checked: Date.now(), at: new Date().toISOString() };
}

async function loadSite() {
  if (siteIdx && Date.now() - siteIdx.checked < 4000) return siteIdx;
  if (siteLoading) return siteLoading;
  siteLoading = (async () => {
    try {
      const headers = {};
      if (siteIdx && siteIdx.etag) headers["if-none-match"] = siteIdx.etag;
      const r = await fetch(SITE_URL + (SITE_URL.includes("?") ? "&" : "?") + "_=" + Date.now(), { headers, signal: AbortSignal.timeout(25000) });
      if (r.status === 304 && siteIdx) { siteIdx.checked = Date.now(); return siteIdx; }
      if (!r.ok) throw new Error("site " + r.status);
      const html = await r.text();
      const etag = r.headers.get("etag") || "";
      if (siteIdx && siteIdx.rawLen === html.length && siteIdx.sig === html.slice(-400)) { siteIdx.checked = Date.now(); return siteIdx; }
      siteIdx = buildSite(html, etag);
      siteIdx.rawLen = html.length; siteIdx.sig = html.slice(-400);
      return siteIdx;
    } catch (e) {
      note("site", 0, String(e && e.message || e).slice(0, 80));
      if (siteIdx) return siteIdx;
      throw e;
    } finally { siteLoading = null; }
  })();
  return siteLoading;
}

function siteSearch(idx, q, k = 8) {
  const qt = [...new Set(tok(q))].slice(0, 40);
  const N = idx.chunks.length, K1 = 1.4, B = 0.75;
  const idents = (String(q).match(/[A-Za-z_$][\w$]{4,}/g) || []).slice(0, 8);
  const scored = [];
  for (const c of idx.chunks) {
    let sc = 0;
    for (const t of qt) {
      const f = c.tf.get(t); if (!f) continue;
      const d = idx.df.get(t) || 1;
      const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
      sc += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * c.len / idx.avg));
    }
    for (const id of idents) if (c.text.includes(id)) sc += 4;
    if (sc > 0) scored.push({ c, sc });
  }
  scored.sort((a, b) => b.sc - a.sc);
  return scored.slice(0, k).map(x => x.c).sort((a, b) => a.s - b.s);
}

function lineWindow(idx, n, r = 14) {
  const a = Math.max(1, n - r), b = Math.min(idx.raw.length, n + r);
  const out = [];
  for (let i = a; i <= b; i++) {
    let ln = idx.raw[i - 1].replace(BASE64_RE, "data:…base64…");
    if (ln.length > 600) ln = ln.slice(0, 600) + " …";
    out.push(i + ": " + ln);
  }
  return out.join("\n");
}

async function siteApi(req, res) {
  cors(res, req);
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return json(res, 429, { error: "limited" });
  let body;
  try { body = JSON.parse(await readBody(req, 60_000)); }
  catch { return json(res, 400, { error: "bad" }); }
  const q = typeof body.q === "string" ? body.q.slice(0, 900) : "";
  const errs = Array.isArray(body.errors) ? body.errors.slice(0, 5) : [];
  try {
    const idx = await loadSite();
    const parts = [];
    let seen = 0;
    const errLines = [];
    for (const e of errs) {
      const ln = e && parseInt(e.line, 10);
      if (ln > 0 && ln <= idx.raw.length && !errLines.includes(ln)) errLines.push(ln);
    }
    for (const ln of errLines.slice(0, 3)) {
      const w = lineWindow(idx, ln);
      parts.push("// შეცდომის ადგილი, ხაზი " + ln + " (ნომერი = ხაზის ნომერი index.html-ში)\n" + w);
      seen += w.length;
    }
    const errText = errs.map(e => String((e && e.msg) || "")).join(" ").slice(0, 300);
    const hits = siteSearch(idx, q + " " + errText, 8);
    for (const c of hits) {
      if (seen > 15000) break;
      parts.push("// ხაზები " + c.s + "–" + c.e + "\n" + c.text);
      seen += c.text.length;
    }
    return json(res, 200, { hash: idx.hash, lines: idx.raw.length, at: idx.at, outline: idx.outline, code: parts.join("\n\n-----\n\n") });
  } catch (e) {
    return json(res, 502, { error: "site unavailable" });
  }
}

async function chat(req, res) {
  cors(res, req);
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return json(res, 429, { error: "ძალიან ბევრი მოთხოვნაა. ერთი წუთით მოიცადე." });
  if (!HAS_ANY_KEY()) return json(res, 500, { error: "სერვისი ახლა მიუწვდომელია." });

  let body;
  try { body = JSON.parse(await readBody(req, 260_000)); }
  catch { return json(res, 400, { error: "არასწორი მოთხოვნა." }); }
  const siteCtx = typeof body.site === "string" ? body.site.slice(0, 45000) : "";

  const messages = cleanMessages(body.messages);
  if (!messages) return json(res, 400, { error: "შეტყობინებები არასწორია." });

  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());

  const url = (process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com") + "/v1beta/models/" +
    encodeURIComponent(MODEL) + ":streamGenerateContent?alt=sse";
  const system = systemPrompt(body.tz) + (siteCtx ? "\n\n" + siteCtx : "");
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  const call = (model, withSearch) => fetch(
    (process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com") + "/v1beta/models/" + encodeURIComponent(model) + ":streamGenerateContent?alt=sse",
    {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { maxOutputTokens: MAX_TOKENS }
      })
    }
  );

  // მოდელებს რიგრიგობით ვცდით: ლიმიტი ამოიწურა (429), გადატვირთულია (5xx) ან ძებნა არ გავიდა (400) — შემდეგი ვარიანტი
  let opened = null, fail = { status: 0, daily: false, zero: false, retryMs: 0, detail: "" };
  try {
    for (let round = 0; round < 2 && !opened && API_KEY; round++) {
      let waitMs = 0;
      for (const model of MODELS) {
        let useSearch = SEARCH;
        for (let k = 0; k < 2 && !opened; k++) {
          const r = await call(model, useSearch);
          if (r.ok) { opened = { up: r, model, usedSearch: useSearch }; break; }
          const text = await r.text().catch(() => "");
          note("gemini", r.status);
          console.error("Gemini", model, useSearch ? "(ძებნით)" : "(ძებნის გარეშე)", r.status, text.slice(0, 1200));
          fail = {
            status: fail.status === 429 ? 429 : r.status, // 429 უფრო მნიშვნელოვანია, ვიდრე ბოლო მოდელის 404
            daily: fail.daily || /PerDay|per day/i.test(text),
            zero: fail.zero || /limit:\s*0\b/.test(text),
            retryMs: Math.max(fail.retryMs || 0, retryDelayMs(text)),
            detail: fail.detail || (model + " " + r.status + ": " + errMsg(text))
          };
          if (r.status === 429) waitMs = Math.max(waitMs, fail.retryMs);
          if (r.status === 400 && useSearch) { useSearch = false; continue; } // იგივე მოდელი, ძებნის გარეშე
          break;
        }
        if (opened) break;
      }
      // მოკლე წუთობრივი ლიმიტი: ცოტას დაველოდოთ და მეორე წრე ვცადოთ
      if (!opened && round === 0 && waitMs > 0 && waitMs <= 12000 && !fail.daily && !ctrl.signal.aborted) await sleep(waitMs + 400);
      else break;
    }
  } catch (e) {
    if (ctrl.signal.aborted) return;
    return json(res, 502, { error: "კავშირი ვერ მოხერხდა. სცადე თავიდან." });
  }

  if (!opened && !ctrl.signal.aborted) {
    const alt = await openAiChain(fallbackSystem(body.tz) + (siteCtx ? "\n\n" + siteCtx : ""), messages, ctrl.signal);
    if (alt && alt.canned) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
      res.write("data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: alt.canned } }) + "\n\n");
      lastUsed = "canned";
      return res.end();
    }
    if (alt) { console.error("გამოყენებულია სარეზერვო:", alt.prov, alt.model); lastUsed = alt.prov + ":" + alt.model; return pipeOpenAi(res, alt, ctrl); }
  }
  if (!opened) {
    // მომხმარებელს მომწოდებლის სახელს ან ტექნიკურ დეტალებს არ ვაჩვენებთ; ისინი მხოლოდ სერვერის ლოგშია
    let msg = "ახლა პასუხის მიღება ვერ მოხერხდა. სცადე რამდენიმე წუთში.";
    if (fail.status === 429) msg = fail.daily ? "დღევანდელი ლიმიტი ამოიწურა. სცადე მოგვიანებით." : "ახლა ძალიან დატვირთულია. სცადე რამდენიმე წამში.";
    if (DEBUG && fail.detail) msg += " [" + fail.detail + "]";
    return json(res, 502, { error: msg });
  }
  const up = opened.up, model = opened.model, usedSearch = opened.usedSearch;
  if (model !== MODEL) console.error("გამოყენებულია სარეზერვო მოდელი:", model);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no"
  });

  // Gemini-ს ნაკადს ვაქცევთ იმ ფორმატად, რომელსაც Index.html კითხულობს
  const sources = new Map(); // ძებნის წყაროები (uri -> სათაური)
  let st = { emitted: false, reason: "", error: "" };
  const send = text => {
    st.emitted = true;
    res.write("data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } }) + "\n\n");
  };
  const handle = line => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    try {
      const j = JSON.parse(data);
      if (j.error) { st.error = String(j.error.message || "error").slice(0, 300); return; }
      if (j.promptFeedback && j.promptFeedback.blockReason) st.reason = "BLOCKED_" + j.promptFeedback.blockReason;
      const cand = (j.candidates || [])[0];
      if (!cand) return;
      if (cand.finishReason && cand.finishReason !== "STOP") st.reason = cand.finishReason;
      for (const p of cand.content?.parts || []) if (typeof p.text === "string" && p.text && !p.thought) send(p.text);
      for (const c of cand.groundingMetadata?.groundingChunks || []) {
        const w = c && c.web;
        if (w && typeof w.uri === "string" && /^https?:\/\//.test(w.uri) && !sources.has(w.uri)) {
          sources.set(w.uri, String(w.title || w.uri).slice(0, 120));
        }
      }
    } catch {}
  };
  const pump = async stream => {
    st = { emitted: false, reason: "", error: "" };
    try {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(handle);
      }
      handle(buf);
    } catch {}
  };

  await pump(up);

  // თუ ძებნით პასუხი ცარიელი დაბრუნდა, ავტომატურად ვცადოთ ძებნის გარეშე
  if (!st.emitted && usedSearch && !ctrl.signal.aborted) {
    console.error("ცარიელი პასუხი ძებნით:", st.reason || "-", st.error || "-", "→ ვცდით ძებნის გარეშე");
    try {
      const up2 = await call(model, false);
      if (up2.ok) await pump(up2);
      else console.error("Gemini (ძებნის გარეშე) შეცდომა", up2.status, await up2.text().catch(() => ""));
    } catch {}
  }

  if (!st.emitted) {
    console.error("ცარიელი პასუხი:", st.reason || "-", st.error || "-");
    let message = "AI-მ ცარიელი პასუხი დააბრუნა. სცადე თავიდან.";
    if (st.reason === "MAX_TOKENS") message = "პასუხი ძალიან გრძელი გამოვიდა და ვერ დასრულდა. სცადე უფრო მოკლე კითხვა.";
    else if (/SAFETY|BLOCK|PROHIBITED|RECITATION|SPII/i.test(st.reason)) message = "ამ კითხვაზე პასუხს ვერ გაგცემ. სცადე სხვაგვარად ჩამოაყალიბე.";
    else if (st.error) message = "AI სერვისმა შეცდომა დააბრუნა. სცადე რამდენიმე წუთში.";
    if (!res.writableEnded) res.write("data: " + JSON.stringify({ type: "error", message }) + "\n\n");
  }

  if (sources.size && st.emitted) {
    const list = [...sources].slice(0, 5).map(([uri, title]) => ({ uri, title }));
    res.write("data: " + JSON.stringify({ type: "sources", sources: list }) + "\n\n");
  }
  res.end();
}

const INDEX = path.join(__dirname, "Index.html");

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS" && (url === "/api/chat" || url === "/api/image" || url === "/api/site")) {
    cors(res, req);
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/api/chat") return chat(req, res);
  if (req.method === "POST" && url === "/api/image") return image(req, res);
  if (req.method === "POST" && url === "/api/site") return siteApi(req, res);

  if (req.method === "GET" && url === "/health") {
    return json(res, 200, { ok: true, version: "fallback-12-site", search: !!OLLAMA_KEY, lastFallback: lastUsed,
      site: siteIdx ? { hash: siteIdx.hash, lines: siteIdx.raw.length, at: siteIdx.at } : null, siteUrl: SITE_URL, keys: { gemini: !!API_KEY, openai: !!OPENAI_KEY, groq: !!GROQ_KEY, ollama: !!OLLAMA_URL, openrouter: !!OPENROUTER_KEY }, recentErrors: recent });
  }

  if (req.method === "GET" && (url === "/" || url === "/Index.html" || url === "/index.html")) {
    fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500); return res.end("Index.html not found"); }
      // no-cache: ბრაუზერი ყოველთვის უახლეს ვერსიას იღებს განახლების შემდეგ
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("AI ჩატი გაშვებულია: http://localhost:" + PORT);
  if (!HAS_ANY_KEY()) console.warn("გაფრთხილება: არც ერთი API გასაღები არ არის დაყენებული.");
});
