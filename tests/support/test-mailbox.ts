import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

// readiness §92：只供隔離測試工具讀取本輪 Mailpit；不是產品公開信箱 API。
// 信件內容、驗證連結與 token 只在記憶體中使用，不寫入日誌、斷言訊息或附件。
const run = promisify(execFile);

function mailApi(): string {
  const value = process.env.APP_PLANET_TEST_MAIL_API_URL;
  if (!value) throw new Error("隔離郵件接收器設定不完整。");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("郵件接收器必須是本機 loopback。");
  }
  return value.replace(/\/$/, "");
}

const summarySchema = z.object({
  messages: z.array(z.object({ ID: z.string().min(1), To: z.array(z.object({ Address: z.string() })).nullable() })),
});
const messageSchema = z.object({ HTML: z.string(), Subject: z.string() });

async function mailFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${mailApi()}${path}`, {
    ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`隔離郵件接收器操作失敗（HTTP ${response.status}）。`);
  return response;
}

export async function messageIdsFor(address: string): Promise<string[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const body = summarySchema.parse(await (await mailFetch(`/api/v1/search?query=${query}&limit=50`)).json());
  return body.messages
    .filter((message) => message.To?.some((to) => to.Address.toLowerCase() === address.toLowerCase()))
    .map((message) => message.ID);
}

export type VerificationMail = { readonly id: string; readonly pathAndQuery: string; readonly subject: string };

// 從 HTML 擷取固定落點的驗證連結；只回傳 path+query（原 SiteURL 已核對與 app origin 相同）。
export function extractVerificationPath(html: string, appOrigin: string): string {
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
  const confirm = links.filter((link) => link.includes("/auth/confirm"));
  if (confirm.length !== 1) throw new Error("驗證信必須恰有一個固定落點連結。");
  const url = new URL(confirm[0]!);
  if (url.origin !== appOrigin || url.pathname !== "/auth/confirm") throw new Error("驗證連結不是固定產品落點。");
  return `${url.pathname}${url.search}`;
}

export async function readVerificationMail(id: string, appOrigin: string): Promise<VerificationMail> {
  const message = messageSchema.parse(await (await mailFetch(`/api/v1/message/${encodeURIComponent(id)}`)).json());
  return { id, subject: message.Subject, pathAndQuery: extractVerificationPath(message.HTML, appOrigin) };
}

export async function waitForNewMail(
  address: string, known: readonly string[], appOrigin: string, timeoutMs = 20_000,
): Promise<VerificationMail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = (await messageIdsFor(address)).filter((id) => !known.includes(id));
    if (fresh.length > 0) return readVerificationMail(fresh[0]!, appOrigin);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("隔離郵件接收器在時限內未收到驗證信。");
}

export async function expectNoNewMail(address: string, known: readonly string[], waitMs = 2_500): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return (await messageIdsFor(address)).filter((id) => !known.includes(id)).length;
}

export async function deleteMailFor(addresses: readonly string[]): Promise<void> {
  const ids = (await Promise.all(addresses.map((address) => messageIdsFor(address)))).flat();
  if (ids.length === 0) return;
  await mailFetch("/api/v1/messages", {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ IDs: ids }),
  });
}

export async function deleteAllMail(): Promise<void> {
  await mailFetch("/api/v1/messages", { method: "DELETE" });
}

// 郵件服務故障注入：只操作本輪 runner 建立並命名的郵件接收器容器。
function mailContainer(): string {
  const name = process.env.APP_PLANET_TEST_MAIL_CONTAINER;
  if (!name || !/^supabase_inbucket_app-planet-auth-[0-9a-f]{12}$/.test(name)) {
    throw new Error("郵件接收器容器不是本輪隔離資源。");
  }
  return name;
}

export async function stopMailReceiver(): Promise<void> {
  await run("docker", ["stop", "--time", "2", mailContainer()], { windowsHide: true, timeout: 30_000 });
}

export async function startMailReceiver(): Promise<void> {
  await run("docker", ["start", mailContainer()], { windowsHide: true, timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await mailFetch("/api/v1/messages?limit=1");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error("隔離郵件接收器未在時限內恢復。");
}
