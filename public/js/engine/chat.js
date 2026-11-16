// Anonymous Twitch IRC-over-WebSocket chat reader (read-only, no account needed).
export class TwitchChat {
  constructor(login, { onMessage, onState = () => {} }) {
    this.login = login;
    this.onMessage = onMessage;
    this.onState = onState;
    this.closed = false;
    this.backoff = 1000;
  }

  connect() {
    this.closed = false;
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      ws.send(`JOIN #${this.login}`);
      this.backoff = 1000;
      this.onState('connected');
    };
    ws.onmessage = (ev) => {
      for (const line of String(ev.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send(line.replace('PING', 'PONG')); continue; }
        const msg = parseIrc(line);
        if (msg) this.onMessage(msg);
      }
    };
    ws.onclose = () => {
      this.onState('disconnected');
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
    ws.onerror = () => ws.close();
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

export function parseIrc(line) {
  let rest = line;
  let tags = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) {
      const i = kv.indexOf('=');
      tags[kv.slice(0, i)] = kv.slice(i + 1);
    }
    rest = rest.slice(sp + 1);
  }
  const m = rest.match(/^:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.*)$/);
  if (!m) return null;
  const text = m[2];
  const chars = Array.from(text);
  const emotes = [];
  if (tags.emotes) {
    for (const group of tags.emotes.split('/')) {
      const [, ranges] = group.split(':');
      for (const r of (ranges || '').split(',')) {
        const [a, b] = r.split('-').map(Number);
        if (Number.isFinite(a) && Number.isFinite(b)) emotes.push(chars.slice(a, b + 1).join(''));
      }
    }
  }
  return {
    user: tags['display-name'] || m[1],
    text,
    emotes,
    ts: Date.now(),
    sentTs: Number(tags['tmi-sent-ts']) || Date.now(),
  };
}
