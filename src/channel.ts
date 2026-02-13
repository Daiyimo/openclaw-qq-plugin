import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ReplyPayload,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage, OneBotMessageSegment } from "./types.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
};

const memberCache = new Map<string, { name: string, time: number }>();
const bulkCachedGroups = new Set<string>();

function getCachedMemberName(groupId: string, userId: string): string | null {
    const key = `${groupId}:${userId}`;
    const cached = memberCache.get(key);
    if (cached && Date.now() - cached.time < 3600000) { // 1 hour cache
        return cached.name;
    }
    return null;
}

function setCachedMemberName(groupId: string, userId: string, name: string) {
    memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

async function populateGroupMemberCache(client: OneBotClient, groupId: number) {
    const key = String(groupId);
    if (bulkCachedGroups.has(key)) return;
    try {
        const members = await client.getGroupMemberList(groupId);
        if (Array.isArray(members)) {
            for (const m of members) {
                const name = m.card || m.nickname || String(m.user_id);
                setCachedMemberName(key, String(m.user_id), name);
            }
            bulkCachedGroups.add(key);
        }
    } catch (e) { }
}

function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3): string[] {
  const urls: string[] = [];
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment.type === "image") {
        const url = segment.data?.url || (typeof segment.data?.file === 'string' && (segment.data.file.startsWith('http') || segment.data.file.startsWith('base64://')) ? segment.data.file : undefined);
        if (url) {
          urls.push(url);
          if (urls.length >= maxImages) break;
        }
      }
    }
  } else if (typeof message === "string") {
    const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
    let match;
    while ((match = imageRegex.exec(message)) !== null) {
      const val = match[1].replace(/&amp;/g, "&");
      if (val.startsWith("http") || val.startsWith("base64://")) {
        urls.push(val);
        if (urls.length >= maxImages) break;
      }
    }
  }
  return urls;
}

function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";
  let result = text;
  const imageUrls: string[] = [];
  const imageRegex = /\[CQ:image,[^\]]*(?:url|file)=([^,\]]+)[^\]]*\]/g;
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const val = match[1].replace(/&amp;/g, "&");
    if (val.startsWith("http")) imageUrls.push(val);
  }
  result = result.replace(/\[CQ:face,id=(\d+)\]/g, "[表情]");
  result = result.replace(/\[CQ:[^\]]+\]/g, (match) => match.startsWith("[CQ:image") ? "[图片]" : "");
  result = result.replace(/\s+/g, " ").trim();
  if (imageUrls.length > 0) result = result ? `${result} [图片: ${imageUrls.join(", ")}]` : `[图片: ${imageUrls.join(", ")}]`;
  return result;
}

function getReplyMessageId(message: OneBotMessage | string | undefined, rawMessage?: string): string | null {
  if (message && typeof message !== "string") {
    for (const segment of message) {
      if (segment.type === "reply" && segment.data?.id) {
        const id = String(segment.data.id).trim();
        if (id && /^-?\d+$/.test(id)) return id;
      }
    }
  }
  if (rawMessage) {
    const match = rawMessage.match(/\[CQ:reply,id=(\d+)\]/);
    if (match) return match[1];
  }
  return null;
}

function normalizeTarget(raw: string): string {
  return raw.replace(/^(qq:)/i, "");
}

type TargetType = "private" | "group" | "guild";
interface ParsedTarget {
  type: TargetType;
  userId?: number;
  groupId?: number;
  guildId?: string;
  channelId?: string;
}

/** * 已修正：增加了对协议前缀的递归清洗，确保 "qq:group:123" 也能被正确识别
 */
function parseTarget(to: string): ParsedTarget {
  // 1. 彻底清洗前缀 (例如 qq:group:123 -> group:123)
  const cleanTo = to.replace(/^(qq:)/i, "").trim();

  if (cleanTo.startsWith("group:")) {
    const id = parseInt(cleanTo.slice(6), 10);
    if (isNaN(id)) throw new Error(`Invalid group target: "${cleanTo}"`);
    return { type: "group", groupId: id };
  }
  if (cleanTo.startsWith("guild:")) {
    const parts = cleanTo.split(":");
    if (parts.length < 3) throw new Error(`Invalid guild target format: "${cleanTo}"`);
    return { type: "guild", guildId: parts[1], channelId: parts[2] };
  }
  if (cleanTo.startsWith("private:")) {
    const id = parseInt(cleanTo.slice(8), 10);
    if (isNaN(id)) throw new Error(`Invalid private target: "${cleanTo}"`);
    return { type: "private", userId: id };
  }

  // 2. 默认逻辑：如果是纯数字，尝试作为私聊 ID 处理
  const id = parseInt(cleanTo, 10);
  if (isNaN(id)) {
    throw new Error(`Cannot parse target: "${to}". 使用 "group:群号" 或 "private:QQ号"`);
  }
  return { type: "private", userId: id };
}

async function dispatchMessage(client: OneBotClient, target: ParsedTarget, message: OneBotMessage | string) {
  switch (target.type) {
    case "group":
      await client.sendGroupMsg(target.groupId!, message);
      break;
    case "guild":
      await client.sendGuildChannelMsg(target.guildId!, target.channelId!, message);
      break;
    case "private":
      await client.sendPrivateMsg(target.userId!, message);
      break;
  }
}

const clients = new Map<string, OneBotClient>();
const getClientForAccount = (accountId: string) => clients.get(accountId);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isImageFile = (url: string) => /\.(jpg|jpeg|png|gif|webp)$/i.test(url);

function splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks = [];
    let current = text;
    while (current.length > 0) {
        chunks.push(current.slice(0, limit));
        current = current.slice(limit);
    }
    return chunks;
}

function stripMarkdown(text: string): string {
    return text
        .replace(/\*\*(.*?)\*\*/g, "$1") 
        .replace(/\*(.*?)\*/g, "$1")     
        .replace(/`(.*?)`/g, "$1")       
        .replace(/#+\s+(.*)/g, "$1")     
        .replace(/\[(.*?)\]\(.*?\)/g, "$1") 
        .replace(/^\s*>\s+(.*)/gm, "▎$1") 
        .replace(/```[\s\S]*?```/g, "[代码块]") 
        .replace(/^\|.*\|$/gm, (match) => match.replace(/\|/g, " ").trim())
        .replace(/^[\-\*]\s+/gm, "• "); 
}

function processAntiRisk(text: string): string {
    return text.replace(/(https?:\/\/)/gi, "$1 ");
}

async function resolveMediaUrl(url: string): Promise<string> {
    if (url.startsWith("file:")) {
        try {
            const path = fileURLToPath(url);
            const data = await fs.readFile(path);
            return `base64://${data.toString("base64")}`;
        } catch (e) {
            console.warn(`[QQ] Media resolve failed: ${e}`);
            return url;
        }
    }
    return url;
}

export const qqChannel: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta: {
    id: "qq",
    label: "QQ (OneBot)",
    selectionLabel: "QQ",
    docsPath: "extensions/qq",
    blurb: "Connect to QQ via OneBot v11",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    // @ts-ignore
    deleteMessage: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => {
        // @ts-ignore
        const qq = cfg.channels?.qq;
        if (!qq) return [];
        if (qq.accounts) return Object.keys(qq.accounts);
        return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        // @ts-ignore
        const qq = cfg.channels?.qq;
        const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
        return {
            accountId: id,
            name: accountConfig?.name ?? "QQ Default",
            enabled: true,
            configured: Boolean(accountConfig?.wsUrl),
            tokenSource: accountConfig?.accessToken ? "config" : "none",
            config: accountConfig || {},
        };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc) => ({ accountId: acc.accountId, configured: acc.configured }),
  },
  directory: {
      listPeers: async ({ accountId }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          try {
              const friends = await client.getFriendList();
              return friends.map(f => ({
                  id: String(f.user_id),
                  name: f.remark || f.nickname,
                  type: "user" as const,
                  metadata: { ...f }
              }));
          } catch (e) { return []; }
      },
      listGroups: async ({ accountId, cfg }) => {
          const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
          if (!client) return [];
          const list: any[] = [];
          try {
              const groups = await client.getGroupList();
              list.push(...groups.map(g => ({
                  id: String(g.group_id),
                  name: g.group_name,
                  type: "group" as const,
                  metadata: { ...g }
              })));
          } catch (e) {}
          // @ts-ignore
          if (cfg?.channels?.qq?.enableGuilds ?? true) {
              try {
                  const guilds = await client.getGuildList();
                  list.push(...guilds.map(g => ({
                      id: `guild:${g.guild_id}`,
                      name: `[频道] ${g.guild_name}`,
                      type: "group" as const,
                      metadata: { ...g }
                  })));
              } catch (e) {}
          }
          return list;
      }
  },
  status: {
      probeAccount: async ({ account, timeoutMs }) => {
          if (!account.config.wsUrl) return { ok: false, error: "Missing wsUrl" };
          const client = new OneBotClient({
              wsUrl: account.config.wsUrl,
              httpUrl: account.config.httpUrl,
              accessToken: account.config.accessToken,
          });
          return new Promise((resolve) => {
              const timer = setTimeout(() => {
                  client.disconnect();
                  resolve({ ok: false, error: "Connection timeout" });
              }, timeoutMs || 5000);
              client.on("connect", async () => {
                  try {
                      const info = await client.getLoginInfo();
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ ok: true, bot: { id: String(info.user_id), username: info.nickname } });
                  } catch (e) {
                      clearTimeout(timer);
                      client.disconnect();
                      resolve({ ok: false, error: String(e) });
                  }
              });
              client.on("error", (err) => {
                  clearTimeout(timer);
                  resolve({ ok: false, error: String(err) });
              });
              client.connect();
          });
      },
      buildAccountSnapshot: ({ account, runtime, probe }) => ({
              accountId: account.accountId,
              name: account.name,
              enabled: account.enabled,
              configured: account.configured,
              running: runtime?.running ?? false,
              lastStartAt: runtime?.lastStartAt ?? null,
              lastError: runtime?.lastError ?? null,
              probe,
      })
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({ cfg, channelKey: "qq", accountId, name }),
    validateInput: () => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
        const namedConfig = applyAccountNameToChannelSection({ cfg, channelKey: "qq", accountId, name: input.name });
        const next = accountId !== DEFAULT_ACCOUNT_ID ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "qq" }) : namedConfig;
        const newConfig = { wsUrl: input.wsUrl || "ws://localhost:3001", httpUrl: input.httpUrl, reverseWsPort: input.reverseWsPort, accessToken: input.accessToken, enabled: true };
        if (accountId === DEFAULT_ACCOUNT_ID) {
            return { ...next, channels: { ...next.channels, qq: { ...next.channels?.qq, ...newConfig } } };
        }
        return { ...next, channels: { ...next.channels, qq: { ...next.channels?.qq, enabled: true, accounts: { ...next.channels?.qq?.accounts, [accountId]: { ...next.channels?.qq?.accounts?.[accountId], ...newConfig } } } } };
    }
  },
  gateway: {
    startAccount: async (ctx) => {
        const { account, cfg } = ctx;
        const config = account.config;
        if (!config.wsUrl) throw new Error("QQ: wsUrl is required");
        const existingClient = clients.get(account.accountId);
        if (existingClient) existingClient.disconnect();

        const client = new OneBotClient({
            wsUrl: config.wsUrl,
            httpUrl: config.httpUrl,
            reverseWsPort: config.reverseWsPort,
            accessToken: config.accessToken,
        });
        clients.set(account.accountId, client);

        const processedMsgIds = new Set<string>();
        const cleanupInterval = setInterval(() => { if (processedMsgIds.size > 1000) processedMsgIds.clear(); }, 3600000);

        client.on("connect", async () => {
             try {
                const info = await client.getLoginInfo();
                if (info?.user_id) client.setSelfId(info.user_id);
                getQQRuntime().channel.activity.record({ channel: "qq", accountId: account.accountId, direction: "inbound" });
             } catch (err) { }
        });

        client.on("message", async (event) => {
          try {
            if (event.post_type === "meta_event") return;
            const selfId = client.getSelfId() || event.self_id;
            if (selfId && String(event.user_id) === String(selfId)) return;
            if (config.enableDeduplication !== false && event.message_id && processedMsgIds.has(String(event.message_id))) return;
            if (event.message_id) processedMsgIds.add(String(event.message_id));

            const isGroup = event.message_type === "group";
            const isGuild = event.message_type === "guild";
            const userId = event.user_id;
            const groupId = event.group_id;

            if (isGroup && groupId) await populateGroupMemberCache(client, groupId);

            let text = event.raw_message || "";
            if (Array.isArray(event.message)) {
                let resolvedText = "";
                for (const seg of event.message) {
                    if (seg.type === "text") resolvedText += seg.data?.text || "";
                    else if (seg.type === "at") {
                        let name = seg.data?.qq;
                        if (name !== "all" && isGroup) name = getCachedMemberName(String(groupId), String(name)) || name;
                        resolvedText += ` @${name} `;
                    }
                    else if (seg.type === "image") resolvedText += " [图片]";
                }
                if (resolvedText) text = resolvedText;
            }

            let fromId = isGroup ? `group:${groupId}` : isGuild ? `guild:${event.guild_id}:${event.channel_id}` : String(userId);
            const runtime = getQQRuntime();

            const deliver = async (payload: ReplyPayload) => {
                 const send = async (msg: string) => {
                     let processed = config.formatMarkdown ? stripMarkdown(msg) : msg;
                     if (config.antiRiskMode) processed = processAntiRisk(processed);
                     const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                     for (let i = 0; i < chunks.length; i++) {
                         let chunk = chunks[i];
                         if (isGroup && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;
                         if (isGroup) await client.sendGroupMsg(groupId!, chunk);
                         else if (isGuild) await client.sendGuildChannelMsg(event.guild_id!, event.channel_id!, chunk);
                         else await client.sendPrivateMsg(userId!, chunk);
                         if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                     }
                 };
                 if (payload.text) await send(payload.text);
            };

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });
            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", Body: cleanCQCodes(text), RawBody: text,
                SenderId: String(userId), SenderName: event.sender?.nickname || "Unknown", ConversationLabel: `QQ ${fromId}`,
                SessionKey: `qq:${fromId}`, AccountId: account.accountId, ChatType: isGroup ? "group" : isGuild ? "channel" : "direct", Timestamp: event.time * 1000,
                OriginatingChannel: "qq", OriginatingTo: fromId, CommandAuthorized: true,
            });

            await runtime.channel.session.recordInboundSession({
                storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: "default" }),
                sessionKey: ctxPayload.SessionKey!, ctx: ctxPayload,
                updateLastRoute: { sessionKey: ctxPayload.SessionKey!, channel: "qq", to: fromId, accountId: account.accountId },
            });

            try { await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
            } catch (error) { if (config.enableErrorNotify) deliver({ text: "⚠️ 服务调用失败。" }); }
          } catch (err) { console.error("[QQ] Critical error:", err); }
        });

        client.connect();
        return () => { clearInterval(cleanupInterval); client.disconnect(); clients.delete(account.accountId); };
    },
    logoutAccount: async () => ({ loggedOut: true, cleared: true })
  },
  outbound: {
    // 通用 send 方法，兼容定时任务调用
    send: async (params: any) => {
      console.log(`[QQ][outbound.send] raw params:`, JSON.stringify(params));
      const { to, text, accountId, replyTo, message, content } = params;
      const msgText = text || message || content || "";
      console.log(`[QQ][outbound.send] parsed to="${to}", text="${String(msgText).substring(0, 100)}...", accountId="${accountId}"`);
      return qqChannel.outbound?.sendText?.({ to, text: msgText, accountId, replyTo });
    },
    sendText: async ({ to, text, accountId, replyTo }) => {
        console.log(`[QQ][outbound.sendText] called with to="${to}", text="${String(text).substring(0, 50)}...", accountId="${accountId}"`);
        if (!to || to === "heartbeat") return { channel: "qq", sent: true };
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
        try {
            // 修正点：在解析前先进行递归清洗，确保 to 的格式正确
            const target = parseTarget(to);
            console.log(`[QQ][outbound.sendText] parsed target:`, target);
            const chunks = splitMessage(text, 4000);
            for (let i = 0; i < chunks.length; i++) {
                let message: OneBotMessage | string = chunks[i];
                if (replyTo && i === 0) message = [ { type: "reply", data: { id: String(replyTo) } }, { type: "text", data: { text: chunks[i] } } ];
                await dispatchMessage(client, target, message);
                if (chunks.length > 1) await sleep(1000);
            }
            return { channel: "qq", sent: true };
        } catch (err) {
            console.error("[QQ][outbound.sendText] FAILED:", err);
            return { channel: "qq", sent: false, error: String(err) };
        }
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }) => {
         if (!to || to === "heartbeat") return { channel: "qq", sent: true };
         const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
         if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
         try {
             const target = parseTarget(to);
             const finalUrl = await resolveMediaUrl(mediaUrl);
             const message: OneBotMessage = [];
             if (replyTo) message.push({ type: "reply", data: { id: String(replyTo) } });
             if (text) message.push({ type: "text", data: { text } });
             if (isImageFile(mediaUrl)) message.push({ type: "image", data: { file: finalUrl } });
             else message.push({ type: "text", data: { text: `[文件] ${finalUrl}` } });
             await dispatchMessage(client, target, message);
             return { channel: "qq", sent: true };
         } catch (err) { return { channel: "qq", sent: false, error: String(err) }; }
    }
  },
  messaging: {
      normalizeTarget,
      targetResolver: {
          looksLikeId: (id) => /^\d{5,12}$/.test(id) || /^(group|guild|private):/.test(id),
          hint: "QQ号, private:QQ号, group:群号, 或 guild:频道ID:子频道ID",
      }
  },
  setup: { resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) }
};
