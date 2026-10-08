// Gemini API で診療時間を読み取る
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const PROMPT = `あなたは日本の医療機関の情報を整理するアシスタントです。
与えられた情報源から、施設の診療時間などを読み取り、次の形式のJSONのみを出力してください（説明文は不要）。

{
  "name": "施設名（「医療法人○○会」などの法人名は除いた通称。例: 大正病院）または null",
  "phone": "電話番号 または null",
  "address": "住所 または null",
  "department": "主な診療科（例: 内科）または null",
  "reservation": 予約優先・予約制なら true、それ以外は false,
  "closedOnHolidays": 祝日が休診なら true、不明・診療ありなら false,
  "sessions": [
    { "start": "09:00", "end": "12:00", "days": [月,火,水,木,金,土,日 の7個の true/false] }
  ],
  "notes": "臨時休診・受付終了時刻・休憩など補足があれば短く。なければ null"
}

ルール:
- 時刻は24時間表記 "HH:MM"。
- 午前・午後など時間帯ごとに sessions を分ける。曜日によって時間が違う場合（例: 土曜は 9:00〜13:00）は別の行にする。
- days は月曜から日曜の順。その時間帯に診療している曜日を true。
- 読み取れない項目は null。推測で埋めない。`;

export async function extractSchedule({ apiKey, model, url, text, image, department }) {
  if (!apiKey) throw new Error('設定画面で Gemini API キーを登録してください。');
  const parts = [{ text: PROMPT }];
  const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0 } };

  if (department) {
    parts.push({ text: `診療科ごとに時間が違う場合は「${department}」の外来診療時間を答えてください。` });
  }
  if (url) {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* 不正なURLはそのまま渡す */ }
    parts.push({ text: `情報源のURL: ${url}
まずこのページを読んでください。診療時間が載っていなければ、Google 検索（例: "site:${host} 外来 診療時間"）で同じサイト内の外来案内・診療時間・担当医表のページを探して読んでください。
このサイト（${host}）以外の情報は使わないでください。` });
    // URL の読み込みに加え、トップページに時間が無いサイト向けにサイト内検索もできるようにする
    body.tools = [{ url_context: {} }, { google_search: {} }];
  }
  if (text) parts.push({ text: `情報源のテキスト:\n${text}` });
  if (image) parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });

  const json = await callGemini(apiKey, model, body);

  const cand = json.candidates?.[0];
  const out = textOf(json);
  const meta = cand?.urlContextMetadata?.urlMetadata || cand?.url_context_metadata?.url_metadata || [];
  const urlFailed = url && meta.length > 0 && meta.every((m) => !/SUCCESS/.test(m.urlRetrievalStatus || m.url_retrieval_status || ''));

  // 読み込みに失敗したのに記憶から答えることがあるため、推測の値は使わない
  if (urlFailed) throw new Error('サイトを読み込めませんでした。ページの文章を貼り付けるか、診療時間の画像から読み取ってください。');

  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error('診療時間を読み取れませんでした。別の方法をお試しください。');
  }
  const data = normalize(JSON.parse(out.slice(start, end + 1)));
  // 診療時間が無くても施設名・電話・住所が取れていれば返す（呼び出し側で案内する）
  if (!data.sessions.length && !data.name && !data.phone && !data.address) {
    throw new Error('診療時間が見つかりませんでした。診療案内のページのURLや画像でお試しください。');
  }
  return data;
}

async function callGemini(apiKey, model, body) {
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    if (res.status === 429) throw new Error(quotaMessage(json.error));
    if (res.status === 400 && /API key/i.test(msg)) throw new Error('Gemini API キーが正しくありません。設定画面を確認してください。');
    if (res.status === 404 || /no longer available|not found/i.test(msg)) {
      const err = new Error(`モデル「${model}」は使えません。設定画面でモデル名を確認してください。`);
      err.code = 'model_unavailable';
      throw err;
    }
    throw new Error(`Gemini API エラー: ${msg}`);
  }
  return json;
}

const textOf = (json) => (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');

// 施設名などから候補を検索する（Google 検索を使う）
export async function searchFacilities({ apiKey, model, query, category }) {
  if (!apiKey) throw new Error('設定画面で Gemini API キーを登録してください。');
  const prompt = `日本の医療機関を必ず Google 検索ツールで検索してから答えてください（記憶だけで答えないこと）。
検索語: 「${query}」${category ? `（種類: ${category}）` : ''}

名前が完全に一致する施設を優先し、足りなければ似た名前の施設も含めて最大5件、次の形式のJSON配列のみで出力してください（説明文は不要）。
[{ "name": "施設名（法人名は除いた通称）", "address": "住所（都道府県から）", "url": "公式サイトのURL" }]

ルール:
- url は検索結果で確認できた公式サイトのURLのみ。病院検索サイト・口コミサイト・地図サイトのURLは不可。分からなければ null。
- 同名の施設が複数の地域にある場合はそれぞれ別の候補にする。
- 見つからなければ [] を出力。`;
  const json = await callGemini(apiKey, model, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
  });
  const out = textOf(json);
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end < 0) return [];
  let list;
  try { list = JSON.parse(out.slice(start, end + 1)); } catch { return []; }
  return (Array.isArray(list) ? list : [])
    .map((c) => ({ name: str(c.name), address: str(c.address), url: /^https?:\/\//.test(str(c.url)) ? str(c.url) : '' }))
    .filter((c) => c.name)
    .slice(0, 5);
}

// 429 の詳細から、どの上限に当たったかを分かる言葉にする
function quotaMessage(err) {
  const details = err?.details || [];
  const ids = details.flatMap((d) => d.violations || []).map((v) => v.quotaId || '').filter(Boolean);
  const retry = details.find((d) => d.retryDelay)?.retryDelay;
  const raw = err?.message || '';
  const model = raw.match(/model:\s*([\w.-]+)/)?.[1];
  const info = ids.length ? `（詳細: ${[...new Set(ids)].join(', ')}${model ? ` / ${model}` : ''}）` : '';
  if (/limit:\s*0\b/.test(raw)) {
    return `このキーの無料枠では、このモデル${model ? `「${model}」` : ''}や検索機能が使えません。設定画面でモデルを変えるか、別のキーをお試しください${info}`;
  }
  if (ids.some((id) => /PerDay/i.test(id))) return `本日の無料枠の上限に達しました。明日以降に再度お試しください${info}`;
  if (ids.some((id) => /PerMinute/i.test(id))) {
    return `1分あたりの上限に達しました。${retry ? `${Math.ceil(parseFloat(retry))}秒` : '1分'}ほど待ってから再度お試しください${info}`;
  }
  return `Gemini の利用上限に達しました。しばらく待ってから再度お試しください${info || `（${raw.slice(0, 120)}）`}`;
}

function str(v) {
  return typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim() : '';
}

function time(v) {
  const m = String(v || '').match(/(\d{1,2})[:：](\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

function normalize(d) {
  const sessions = (Array.isArray(d.sessions) ? d.sessions : [])
    .map((s) => ({
      start: time(s.start),
      end: time(s.end),
      days: Array.from({ length: 7 }, (_, i) => !!(Array.isArray(s.days) && s.days[i])),
    }))
    .filter((s) => s.start && s.end && s.days.some(Boolean));
  return {
    name: str(d.name),
    phone: str(d.phone),
    address: str(d.address),
    department: str(d.department),
    reservation: d.reservation === true,
    closedOnHolidays: d.closedOnHolidays === true,
    sessions,
    notes: str(d.notes),
  };
}

export function fileToInlineImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const [head, base64] = String(reader.result).split(',');
      resolve({ mimeType: head.match(/data:(.*?);/)?.[1] || file.type || 'image/jpeg', base64 });
    };
    reader.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    reader.readAsDataURL(file);
  });
}
