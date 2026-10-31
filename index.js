/**
 * ST Phone — 폰·SNS 시뮬레이터 (SillyTavern 확장)
 *
 * 구조: 코드가 앱 구조·저장·정보 차단을 맡고, AI는 "내용"(문자/게시글/댓글)만 JSON으로 생성한다.
 * 데이터는 채팅(chat metadata)별로 저장되어 RP마다 폰이 분리된다.
 */
(() => {
    'use strict';

    const MODULE = 'st_phone_sim';
    const ctx = () => SillyTavern.getContext();

    const DEFAULTS = {
        enabled: true,
        inject: true,       // 폰 활동을 메인 채팅 프롬프트에 주입
        injectCount: 8,     // 주입할 최근 활동 수
        autoReply: true,    // 내가 문자를 보내면 자동으로 답장 생성
        autoReact: true,    // 내가 글을 올리면 자동으로 반응 생성
        autoMode: false,    // 자동 모드: 메인 채팅이 진행되면 캐릭터가 알아서 폰 활동
        autoEvery: 4,       // 캐릭터 메시지 N개마다 한 번 실행
        autoClock: 10,      // 캐릭터 메시지 1개당 폰 시간 진행(분), 0이면 진행 안 함
        maxPosts: 200,      // 채팅별 최대 게시글 보관 수
        maxMessages: 300,   // 상대별 최대 문자 보관 수
        maxTextLength: 2000,
        lang: '한국어',
        accent: '#7bd389',
        pos: null,          // 버블 위치 {x, y}
    };

    /* ───────────── 설정 / 상태 ───────────── */

    function getSettings() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        const s = extensionSettings[MODULE];
        for (const k of Object.keys(DEFAULTS)) if (!(k in s)) s[k] = DEFAULTS[k];
        return s;
    }
    const saveSettings = () => ctx().saveSettingsDebounced();

    const pad = n => String(n).padStart(2, '0');
    function fmtClock(d) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    function parseClock(s) {
        const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
        if (!m) return null;
        const [, ys, mos, ds, hs, mis] = m;
        const y = +ys, mo = +mos, day = +ds, h = +hs, mi = +mis;
        if (mo < 1 || mo > 12 || h > 23 || mi > 59 || day < 1) return null;
        const d = new Date(y, mo - 1, day, h, mi);
        return d.getFullYear() === y && d.getMonth() === mo - 1 &&
            d.getDate() === day && d.getHours() === h && d.getMinutes() === mi ? d : null;
    }
    function shortTime(s) {
        const d = parseClock(s);
        return d ? `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
    }

    function newState() {
        return {
            schemaVersion: 2, clock: fmtClock(new Date()), seq: 0,
            follows: {}, known: [], init: {}, posts: [], threads: {},
            unread: {}, autoCount: 0
        };
    }

    const userName = () => ctx().name1 || 'User';

    function charNames() {
        const c = ctx();
        if (c.groupId) {
            const g = (c.groups || []).find(x => String(x.id) === String(c.groupId));
            const names = ((g && g.members) || [])
                .map(av => (c.characters || []).find(ch => ch.avatar === av))
                .filter(Boolean)
                .map(ch => ch.name);
            if (names.length) return names;
        }
        const ch = c.characters && c.characters[c.characterId];
        if (ch && ch.name) return [ch.name];
        return c.name2 && c.name2 !== 'System' ? [c.name2] : [];
    }

    function getState() {
        const meta = ctx().chatMetadata;
        if (!meta) return null;
        if (!meta[MODULE] || typeof meta[MODULE] !== 'object') meta[MODULE] = newState();
        const st = meta[MODULE];
        migrateState(st);
        ensureDefaults(st);
        return st;
    }

    // 저장된 예전 데이터와 손상된 일부 필드를 안전하게 보완한다.
    function migrateState(st) {
        if (!st || typeof st !== 'object') return;
        if (!Number.isFinite(+st.schemaVersion)) st.schemaVersion = 1;
        if (!Array.isArray(st.posts)) st.posts = [];
        if (!st.threads || typeof st.threads !== 'object' || Array.isArray(st.threads)) st.threads = {};
        if (!st.follows || typeof st.follows !== 'object' || Array.isArray(st.follows)) st.follows = {};
        if (!Array.isArray(st.known)) st.known = [];
        st.known = [...new Set(st.known.map(x => String(x).slice(0, 60)))].slice(-200);
        if (!st.init || typeof st.init !== 'object' || Array.isArray(st.init)) st.init = {};
        if (!st.unread || typeof st.unread !== 'object' || Array.isArray(st.unread)) st.unread = {};
        for (const [name, list] of Object.entries(st.follows)) {
            if (!Array.isArray(list)) st.follows[name] = [];
            else st.follows[name] = list.map(String).slice(0, 500);
        }
        if (!Number.isFinite(+st.seq)) st.seq = 0;
        if (!Number.isFinite(+st.autoCount)) st.autoCount = 0;
        if (!parseClock(st.clock)) st.clock = fmtClock(new Date());
        st.posts = st.posts.filter(p => p && typeof p === 'object' && Number.isFinite(+p.id))
            .map(p => ({
                id: +p.id, author: String(p.author || 'Unknown').slice(0, 60),
                text: String(p.text || '').slice(0, 2000), time: parseClock(p.time) ? fmtClock(parseClock(p.time)) : st.clock,
                tags: Array.isArray(p.tags) ? p.tags.slice(0, 5).map(x => String(x).slice(0, 40)) : [],
                likes: Array.isArray(p.likes) ? p.likes.map(String).slice(0, 500) : [],
                extraLikes: Math.max(0, Math.min(999999, parseInt(p.extraLikes, 10) || 0)),
                comments: Array.isArray(p.comments) ? p.comments.filter(c => c && typeof c === 'object')
                    .slice(-100).map(c => ({ id: Number.isFinite(+c.id) ? +c.id : ++st.seq,
                        author: String(c.author || 'Unknown').slice(0, 60),
                        text: String(c.text || '').slice(0, 1000),
                        time: parseClock(c.time) ? fmtClock(parseClock(c.time)) : st.clock })) : []
            }));
        for (const [name, msgs] of Object.entries(st.threads)) {
            if (!Array.isArray(msgs)) { delete st.threads[name]; continue; }
            st.threads[name] = msgs.filter(m => m && typeof m === 'object')
                .slice(-300).map(m => ({ id: Number.isFinite(+m.id) ? +m.id : ++st.seq,
                    from: String(m.from || name).slice(0, 60),
                    to: String(m.to || userName()).slice(0, 60),
                    text: String(m.text || '').slice(0, 2000),
                    time: parseClock(m.time) ? fmtClock(parseClock(m.time)) : st.clock }));
        }
        const ids = [
            ...st.posts.map(p => p.id),
            ...st.posts.flatMap(p => p.comments.map(c => c.id)),
            ...Object.values(st.threads).flatMap(ms => ms.map(m => m.id))
        ];
        st.seq = Math.max(+st.seq || 0, ...ids, 0);
        st.schemaVersion = 2;
    }

    function addTo(arr, v) { if (!arr.includes(v)) arr.push(v); }

    function registerAccount(st, name) {
        if (!name || name === userName()) return;
        addTo(st.known, String(name).slice(0, 60));
        if (st.known.length > 200) st.known.splice(0, st.known.length - 200);
        if (!Array.isArray(st.follows[name])) st.follows[name] = [];
    }

    // 캐릭터와 유저는 처음에 서로 팔로우한 상태로 시작 (이후 프로필 앱에서 변경 가능)
    function ensureDefaults(st) {
        const u = userName();
        if (!st.follows[u]) st.follows[u] = [];
        for (const n of charNames()) {
            registerAccount(st, n);
            if (!st.init[n]) {
                st.init[n] = true;
                addTo(st.follows[n], u);
                addTo(st.follows[u], n);
            }
        }
    }

    function saveState() {
        const c = ctx();
        if (c.saveMetadataDebounced) c.saveMetadataDebounced();
        else if (c.saveMetadata) c.saveMetadata();
        refreshInjection();
    }

    const nid = st => ++st.seq;

    function advance(st, min) {
        const d = parseClock(st.clock) || new Date();
        d.setMinutes(d.getMinutes() + min);
        st.clock = fmtClock(d);
    }

    /* ───────────── 정보 차단(gating) ───────────── */

    const follows = (st, a, b) => (st.follows[a] || []).includes(b);
    const postVisibleTo = (st, p, name) => p.author === name || follows(st, name, p.author);

    function buildEvents(st) {
        const ev = [];
        for (const p of st.posts) {
            ev.push({
                seq: p.id, time: p.time,
                text: `[SNS] ${p.author}: ${p.text}`,
                knows: n => postVisibleTo(st, p, n),
            });
            for (const cm of p.comments) {
                ev.push({
                    seq: cm.id, time: cm.time,
                    text: `[SNS 댓글] ${cm.author} → ${p.author}의 글: ${cm.text}`,
                    knows: n => cm.author === n || postVisibleTo(st, p, n),
                });
            }
        }
        for (const [partner, msgs] of Object.entries(st.threads)) {
            for (const m of msgs) {
                ev.push({
                    seq: m.id, time: m.time,
                    text: `[문자] ${m.from} → ${m.to}: ${m.text}`,
                    knows: n => m.from === n || m.to === n,
                });
            }
        }
        return ev.sort((a, b) => a.seq - b.seq);
    }

    function knowledgeFor(st, names, limit = 6) {
        const ev = buildEvents(st);
        return names.map(n => {
            // 그룹 생성 프롬프트는 모든 멤버의 정보가 한 번에 전달되므로 공통으로 아는 기록만 포함한다.
            const mine = ev.filter(e => names.length > 1 ? names.every(member => e.knows(member)) : e.knows(n))
                .slice(-limit).map(e => `  (${shortTime(e.time)}) ${e.text}`);
            const fl = (st.follows[n] || []).join(', ') || '없음';
            return `- ${n} (팔로우: ${fl})\n${mine.join('\n') || '  (공통으로 아는 폰 활동 없음)'}`;
        }).join('\n');
    }

    /* ───────────── 메인 채팅 주입 ───────────── */

    function refreshInjection() {
        const c = ctx();
        if (!c.setExtensionPrompt) return;
        const s = getSettings();
        const pos = (c.extension_prompt_types && c.extension_prompt_types.IN_CHAT) ?? 1;
        const role = (c.extension_prompt_roles && c.extension_prompt_roles.SYSTEM) ?? 0;
        const st = getState();
        if (!s.enabled || !s.inject || !st) { c.setExtensionPrompt(MODULE, '', pos, 1, false, role); return; }
        const names = charNames();
        // 그룹 프롬프트는 모든 멤버가 공유하므로, 모두가 알 수 있는 기록만 주입한다.
        // 한 명만 아는 DM/비공개 게시글은 그룹 전체 프롬프트에 넣지 않는다.
        const lines = buildEvents(st)
            .filter(e => names.length > 0 && names.every(n => e.knows(n)))
            .slice(-Math.max(1, +s.injectCount || 8))
            .map(e => `(${shortTime(e.time)}) ${e.text}`);
        if (!lines.length) { c.setExtensionPrompt(MODULE, '', pos, 1, false, role); return; }
        const text =
            `[폰 활동 기록 — 현재 폰 시간 ${st.clock}]\n${lines.join('\n')}\n` +
            `(각 캐릭터는 자신이 알 수 있는 활동만 안다. 그룹 채팅에서는 모든 멤버가 공통으로 알 수 있는 기록만 전달된다. 필요할 때만 자연스럽게 언급하고, 이 기록을 그대로 읊지 말 것.)`;
        c.setExtensionPrompt(MODULE, text, pos, 1, false, role);
    }

    /* ───────────── AI 호출 ───────────── */

    let busy = false;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const toast = (type, msg) => { try { window.toastr && window.toastr[type](msg, 'ST Phone'); } catch { /* noop */ } };

    async function ask(instruction) {
        const fn = ctx().generateQuietPrompt;
        if (typeof fn !== 'function') throw new Error('이 실리태번 버전은 generateQuietPrompt를 지원하지 않아요. 업데이트가 필요해요.');
        // 신버전(객체 인자)과 구버전(위치 인자)을 모두 지원
        const out = fn.length === 0
            ? await fn({ quietPrompt: instruction })
            : await fn(instruction, false, false);
        return String(out || '');
    }

    function parseJSON(text) {
        const t = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        const start = t.search(/[\\[{]/);
        if (start < 0) return null;
        const stack = [];
        let quoted = false, escaped = false;
        for (let i = start; i < t.length; i++) {
            const ch = t[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') quoted = false;
                continue;
            }
            if (ch === '"') { quoted = true; continue; }
            if (ch === '{' || ch === '[') stack.push(ch);
            else if (ch === '}' || ch === ']') {
                const open = stack.pop();
                if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return null;
                if (!stack.length) {
                    try { return JSON.parse(t.slice(start, i + 1)); }
                    catch { return null; }
                }
            }
        }
        return null;
    }

    const cleanText = (value, max = 2000) => {
        if (typeof value !== 'string' && typeof value !== 'number') return '';
        return String(value).trim().slice(0, max);
    };
    const validAuthor = (name, user) => {
        const n = cleanText(name, 60);
        return !!n && n !== user && n !== 'System' && !/[\r\n<>]/.test(n);
    };

    function header() {
        return `[시스템 지시: 롤플레이 진행을 잠시 멈추고 아래 작업만 수행하라. 지정된 JSON 형식으로만 출력하고, 설명·코드블록·롤플레이 서술·사고과정은 절대 쓰지 마라. 출력 언어: ${getSettings().lang}]`;
    }

    async function withBusy(label, fn) {
        if (busy) { toast('info', '생성 중이에요. 잠시만 기다려 주세요.'); return; }
        busy = true;
        try { await fn(); }
        catch (e) { console.error('[ST Phone]', e); toast('error', `${label} 실패: ${e.message || e}`); }
        finally { busy = false; typing = null; render(); }
    }

    /* ── 문자 ── */

    function addMsg(st, partner, from, text) {
        registerAccount(st, partner);
        const u = userName();
        const thread = st.threads[partner] = st.threads[partner] || [];
        thread.push({
            id: nid(st), from, to: from === u ? partner : u,
            text: String(text).slice(0, Math.max(100, Math.min(10000, +getSettings().maxTextLength || 2000))), time: st.clock,
        });
        const max = Math.max(20, Math.min(2000, +getSettings().maxMessages || 300));
        if (thread.length > max) thread.splice(0, thread.length - max);
        if (from !== u && !(phoneOpen && view === 'chat' && curPartner === partner)) {
            st.unread[partner] = (st.unread[partner] || 0) + 1;
        }
    }

    async function aiMessages(partner, kind, capturedState = getState()) {
        const st = capturedState;
        if (!st) throw new Error('채팅 데이터를 찾을 수 없어요.');
        const u = userName();
        const hist = (st.threads[partner] || []).slice(-14).map(m => `${m.from}: ${m.text}`).join('\n') || '(아직 대화 없음)';
        const task = kind === 'first'
            ? `${partner}가 ${u}에게 먼저 문자를 보낸다. 폰 시간과 최근 상황에 어울리는 자연스러운 이유로 연락한다.`
            : `${partner}가 ${u}의 마지막 문자에 답장한다.`;
        const prompt = `${header()}
작업: ${task}
현재 폰 시간: ${st.clock}
지금까지의 문자 대화:
${hist}
규칙:
- 실제 문자처럼 짧게 1~3개의 메시지로 나눠 쓴다. (줄임말·이모티콘·오타는 캐릭터 성격에 맞을 때만)
- ${partner}는 메인 채팅에서 일어난 일과 자신이 겪은 폰 활동만 안다. ${u}의 행동·대사를 대신 쓰지 마라.
${partner}가 아는 폰 활동:
${knowledgeFor(st, [partner])}
형식: {"messages":["메시지1","메시지2"]}`;
        const data = parseJSON(await ask(prompt));
        const arr = data && Array.isArray(data.messages) ? data.messages.map(x => cleanText(x, 2000)).filter(Boolean).slice(0, 3) : null;
        if (!arr || !arr.length) throw new Error('AI 응답을 해석하지 못했어요. 다시 시도해 주세요.');
        return arr;
    }

    async function aiSend(partner, kind) {
        const metaAtStart = ctx().chatMetadata;
        const stateAtStart = getState();
        await withBusy('문자 생성', async () => {
            typing = partner; render();
            const arr = await aiMessages(partner, kind, stateAtStart);
            if (!metaAtStart || ctx().chatMetadata !== metaAtStart || metaAtStart[MODULE] !== stateAtStart) {
                toast('warning', '채팅이 변경되어 생성 결과를 저장하지 않았어요.');
                return;
            }
            for (const text of arr) {
                if (ctx().chatMetadata !== metaAtStart || metaAtStart[MODULE] !== stateAtStart) break;
                typing = partner; render();
                await sleep(500 + Math.min(1600, text.length * 45));
                if (ctx().chatMetadata !== metaAtStart || metaAtStart[MODULE] !== stateAtStart) break;
                advance(stateAtStart, 1);
                addMsg(stateAtStart, partner, partner, text);
                typing = null; saveState(); render();
            }
        });
    }

    /* ── 피드 ── */

    function addPost(st, author, text, tags) {
        registerAccount(st, author);
        const p = {
            id: nid(st), author: cleanText(author, 60), text: cleanText(text, getSettings().maxTextLength || 2000), time: st.clock,
            tags: Array.isArray(tags) ? tags.map(t => String(t).replace(/^#/, '')).filter(Boolean).slice(0, 5) : [],
            likes: [], extraLikes: 0, comments: [],
        };
        st.posts.unshift(p);
        const max = Math.max(20, Math.min(1000, +getSettings().maxPosts || 200));
        if (st.posts.length > max) st.posts.length = max;
        return p;
    }

    async function aiPosts() {
        const metaAtStart = ctx().chatMetadata;
        const stateAtStart = getState();
        await withBusy('피드 새로고침', async () => {
            const st = stateAtStart;
            if (!st) return;
            const u = userName();
            const names = charNames();
            const recent = st.posts.slice(0, 6).map(p => `- ${p.author}: ${p.text}`).join('\n') || '(없음)';
            const prompt = `${header()}
작업: 캐릭터들의 SNS 새 게시글 3개를 작성한다.
현재 폰 시간: ${st.clock}
작성자 후보: ${names.join(', ')} (분위기에 맞는 NPC 계정을 최대 1개 섞어도 된다)
${u}(유저) 계정의 글·댓글은 절대 대신 쓰지 마라.
각 작성자는 자신이 직접 겪은 일, 자신이 주고받은 문자, 메인 채팅에서 겪은 일, 팔로우한 계정의 글만 안다. 모르는 정보는 언급하지 마라.
작성자별로 아는 내용:
${knowledgeFor(st, names)}
최근 게시글(내용 반복 금지):
${recent}
형식: {"posts":[{"author":"이름","text":"본문","tags":["태그"]}]}`;
            const data = parseJSON(await ask(prompt));
            if (ctx().chatMetadata !== metaAtStart || !metaAtStart || metaAtStart[MODULE] !== st) {
                toast('warning', '채팅이 변경되어 생성 결과를 저장하지 않았어요.'); return;
            }
            const arr = data && Array.isArray(data.posts) ? data.posts : null;
            if (!arr || !arr.length) throw new Error('AI 응답을 해석하지 못했어요. 다시 시도해 주세요.');
            for (const p of arr.slice(0, 3)) {
                const author = p && cleanText(p.author, 60);
                const body = p && cleanText(p.text, 2000);
                if (!validAuthor(author, u) || !body) continue;
                advance(st, 7);
                addPost(st, author, body, p.tags);
            }
            saveState();
        });
    }

    async function aiReactions(postId) {
        const metaAtStart = ctx().chatMetadata;
        const stateAtStart = getState();
        await withBusy('반응 생성', async () => {
            const st = stateAtStart;
            if (!st) return;
            const p = st.posts.find(x => x.id === postId);
            if (!p) return;
            const u = userName();
            const pool = charNames().filter(n => n !== p.author);
            const prompt = `${header()}
작업: 아래 SNS 게시글에 달릴 반응을 만든다.
현재 폰 시간: ${st.clock}
게시글 작성자: ${p.author}
본문: ${p.text}
기존 댓글:
${p.comments.map(c => `${c.author}: ${c.text}`).join('\n') || '(없음)'}
댓글 작성자 후보: ${pool.join(', ') || '(없음)'} (필요하면 NPC 계정 가능)
규칙:
- ${u}(유저) 이름으로 댓글을 쓰지 마라.
- 글을 볼 수 있는 사람(작성자를 팔로우한 사람)만 반응한다. 작성자 본인은 자기 글에 달린 댓글에 답글을 달 수 있다.
- 댓글은 0~3개, 짧고 SNS답게.
형식: {"likes":0~30,"comments":[{"author":"이름","text":"댓글"}]}`;
            const data = parseJSON(await ask(prompt));
            if (ctx().chatMetadata !== metaAtStart || !metaAtStart || metaAtStart[MODULE] !== st) {
                toast('warning', '채팅이 변경되어 생성 결과를 저장하지 않았어요.'); return;
            }
            if (!data || typeof data !== 'object') throw new Error('AI 응답을 해석하지 못했어요. 다시 시도해 주세요.');
            // 반복 클릭으로 좋아요가 무한 누적되지 않도록 1회 호출의 증가량을 제한한다.
            p.extraLikes = Math.min(999999, p.extraLikes + Math.max(0, Math.min(30, parseInt(data.likes, 10) || 0)));
            for (const cm of (Array.isArray(data.comments) ? data.comments : []).slice(0, 3)) {
                const author = cm && cleanText(cm.author, 60);
                const body = cm && cleanText(cm.text, 1000);
                if (!validAuthor(author, u) || !body || !postVisibleTo(st, p, author)) continue;
                advance(st, 2);
                registerAccount(st, author);
                p.comments.push({ id: nid(st), author, text: body, time: st.clock });
                if (p.comments.length > 100) p.comments.splice(0, p.comments.length - 100);
            }
            saveState();
        });
    }

    /* ── 자동 모드 ── */

    function isGenerating() {
        const el = document.getElementById('mes_stop');
        return !!el && getComputedStyle(el).display !== 'none';
    }

    async function aiAuto(manual, tries = 0) {
        if (busy) { if (manual) toast('info', '생성 중이에요. 잠시만 기다려 주세요.'); return; }
        if (isGenerating() && tries < 5) { setTimeout(() => aiAuto(manual, tries + 1), 3000); return; }
        const metaAtStart = ctx().chatMetadata;
        const st = getState();
        const names = charNames();
        if (!st || !names.length) { if (manual) toast('warning', '캐릭터 채팅을 먼저 열어 주세요.'); return; }
        busy = true;
        try {
            const u = userName();
            const recent = st.posts.slice(0, 6);
            const list = recent.map(p => `- [id:${p.id}] ${p.author}: ${p.text}`).join('\n') || '(없음)';
            const prompt = `${header()}
작업: 시간이 흘러 캐릭터들이 폰으로 자발적으로 한 활동을 만든다. 억지로 만들지 말고, 지금 상황에 자연스러운 것만 쓴다. 활동이 없으면 빈 배열로 답해도 된다.
현재 폰 시간: ${st.clock}
캐릭터: ${names.join(', ')}
가능한 활동:
- posts: 캐릭터가 SNS에 올리는 새 글 (0~2개)
- messages: 캐릭터가 ${u}에게 먼저 보내는 문자 (0~2개)
- comments: 아래 최근 게시글에 캐릭터가 다는 댓글 (0~2개)
규칙:
- ${u}(유저)의 글·문자·댓글은 절대 대신 쓰지 마라.
- 각 캐릭터는 자신이 직접 겪은 일, 자신이 주고받은 문자, 메인 채팅에서 겪은 일, 팔로우한 계정의 글만 안다. 모르는 정보는 언급하지 마라.
- 댓글은 그 글을 볼 수 있는 캐릭터(작성자를 팔로우한 사람)만 쓴다.
캐릭터별로 아는 내용:
${knowledgeFor(st, names)}
최근 게시글:
${list}
형식: {"posts":[{"author":"이름","text":"본문","tags":["태그"]}],"messages":[{"from":"캐릭터","text":"문자 내용"}],"comments":[{"postId":번호,"author":"캐릭터","text":"댓글"}]}`;
            const data = parseJSON(await ask(prompt));
            if (ctx().chatMetadata !== metaAtStart || !metaAtStart || metaAtStart[MODULE] !== st) {
                if (manual) toast('warning', '채팅이 변경되어 생성 결과를 저장하지 않았어요.');
                return;
            }
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('AI 응답을 해석하지 못했어요.');
            let np = 0, nm = 0, nc = 0;
            for (const p of (Array.isArray(data.posts) ? data.posts : []).slice(0, 2)) {
                const author = p && cleanText(p.author, 60);
                const body = p && cleanText(p.text, 2000);
                if (!validAuthor(author, u) || !body) continue;
                advance(st, 3); addPost(st, author, body, p.tags); np++;
            }
            for (const m of (Array.isArray(data.messages) ? data.messages : []).slice(0, 2)) {
                const body = m && cleanText(m.text, 2000);
                if (!m || !body || !names.includes(m.from)) continue;
                advance(st, 2); addMsg(st, m.from, m.from, body); nm++;
            }
            for (const c of (Array.isArray(data.comments) ? data.comments : []).slice(0, 2)) {
                const post = c && st.posts.find(x => x.id === +c.postId);
                const author = c && cleanText(c.author, 60);
                const body = c && cleanText(c.text, 1000);
                if (!post || !body || !validAuthor(author, u) || !postVisibleTo(st, post, author)) continue;
                advance(st, 2);
                registerAccount(st, author);
                post.comments.push({ id: nid(st), author, text: body, time: st.clock });
                if (post.comments.length > 100) post.comments.splice(0, post.comments.length - 100);
                nc++;
            }
            saveState();
            if (np + nm + nc) toast('info', `📱 새 활동: 글 ${np}, 문자 ${nm}, 댓글 ${nc}`);
            else if (manual) toast('info', '이번에는 새 활동이 없었어요.');
        } catch (e) {
            console.error('[ST Phone] 자동 모드', e);
            if (manual) toast('error', `자동 활동 실패: ${e.message || e}`);
        } finally {
            busy = false;
            render();
        }
    }

    function onCharMessage() {
        const s = getSettings();
        if (!s.enabled || !s.autoMode) return;
        const st = getState();
        if (!st) return;
        if (s.autoClock > 0) advance(st, s.autoClock);
        st.autoCount = (st.autoCount || 0) + 1;
        const fire = st.autoCount >= Math.max(1, s.autoEvery);
        if (fire) st.autoCount = 0;
        saveState();
        render();
        if (fire) {
            const scheduledMeta = ctx().chatMetadata;
            setTimeout(() => {
                if (ctx().chatMetadata === scheduledMeta) aiAuto(false);
            }, 2000);
        }
    }

    /* ───────────── UI ───────────── */

    let view = 'home';          // home | msgs | chat | feed | profiles | settings
    let curPartner = null;
    let typing = null;
    let phoneOpen = false;
    let feedFilter = 'all';
    const openComments = new Set();
    let bubbleEl, phoneEl;

    const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    function hue(name) { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
    const avatar = name => `<span class="stp-av" style="background:hsl(${hue(name)} 45% 42%)">${esc(String(name).trim().charAt(0).toUpperCase())}</span>`;

    function totalUnread(st) { return Object.values(st.unread).reduce((a, b) => a + b, 0); }

    function render() {
        if (!phoneEl) return;
        const s = getSettings();
        bubbleEl.style.display = s.enabled ? '' : 'none';
        phoneEl.style.setProperty('--stp-accent', s.accent);
        bubbleEl.style.setProperty('--stp-accent', s.accent);
        const st = getState();
        const unread = st ? totalUnread(st) : 0;
        bubbleEl.querySelector('.stp-badge').textContent = unread ? String(unread) : '';
        if (!phoneOpen) return;

        // 입력값/스크롤 보존
        const keep = {};
        phoneEl.querySelectorAll('[data-keep]').forEach(el => { keep[el.dataset.keep] = el.value; });
        const oldContent = phoneEl.querySelector('.stp-content');
        const oldScroll = oldContent ? oldContent.scrollTop : 0;
        const wasView = phoneEl.dataset.view;

        phoneEl.innerHTML = st ? screen(st) : `<div class="stp-status"><span></span><button data-act="close">✕</button></div><div class="stp-empty">캐릭터 채팅을 먼저 열어 주세요.</div>`;
        phoneEl.dataset.view = view;

        phoneEl.querySelectorAll('[data-keep]').forEach(el => { if (keep[el.dataset.keep] != null) el.value = keep[el.dataset.keep]; });
        const content = phoneEl.querySelector('.stp-content');
        if (content) content.scrollTop = (view === 'chat') ? content.scrollHeight : (wasView === view ? oldScroll : 0);
    }

    function statusBar(st) {
        return `<div class="stp-status"><span>${esc(shortTime(st.clock))}</span><button data-act="close" aria-label="닫기">✕</button></div>`;
    }
    function head(title, opts = {}) {
        const back = opts.back ? `<button class="stp-back" data-act="${opts.back}" aria-label="뒤로">‹</button>` : '';
        return `<div class="stp-head">${back}<h3>${esc(title)}</h3>${opts.tools || ''}</div>`;
    }

    function screen(st) {
        switch (view) {
            case 'msgs': return viewMsgs(st);
            case 'chat': return viewChat(st);
            case 'feed': return viewFeed(st);
            case 'profiles': return viewProfiles(st);
            case 'settings': return viewSettings(st);
            default: return viewHome(st);
        }
    }

    function viewHome(st) {
        const d = parseClock(st.clock) || new Date();
        const u = totalUnread(st);
        const app = (key, icon, label, badge) =>
            `<button class="stp-app" data-act="open" data-app="${key}"><i>${icon}</i>${label}${badge ? `<span class="stp-badge">${badge}</span>` : ''}</button>`;
        return `${statusBar(st)}
<div class="stp-content">
  <div class="stp-home-time"><b>${pad(d.getHours())}:${pad(d.getMinutes())}</b><span>${d.getMonth() + 1}월 ${d.getDate()}일</span></div>
  <div class="stp-home">
    ${app('msgs', '💬', '메시지', u || '')}
    ${app('feed', '📸', '피드')}
    ${app('profiles', '👥', '프로필')}
    ${app('settings', '⚙️', '설정')}
  </div>
</div>`;
    }

    function viewMsgs(st) {
        const names = [...new Set([...charNames(), ...Object.keys(st.threads)])];
        const rows = names.map(n => {
            const t = st.threads[n] || [];
            const last = t[t.length - 1];
            const un = st.unread[n] || 0;
            return `<button class="stp-thread" data-act="open-chat" data-name="${esc(n)}">
  ${avatar(n)}
  <div class="stp-meta"><b>${esc(n)}${un ? `<span class="stp-unread">${un}</span>` : ''}</b><span>${last ? esc(last.text) : '대화를 시작해 보세요'}</span></div>
  <span class="stp-t">${last ? esc(shortTime(last.time)) : ''}</span></button>`;
        }).join('');
        return `${statusBar(st)}${head('메시지', { back: 'home', tools: '<button class="stp-tool" data-act="new-chat">+ 새 대화</button>' })}
<div class="stp-content">${rows || '<div class="stp-empty">대화 상대가 없어요.</div>'}</div>`;
    }

    function viewChat(st) {
        const u = userName();
        const msgs = (st.threads[curPartner] || []).map(m =>
            `<div class="stp-msg ${m.from === u ? 'stp-me' : ''}">${esc(m.text)}<small>${esc(shortTime(m.time))}</small></div>`).join('');
        const dots = typing === curPartner ? '<div class="stp-typing"><span></span><span></span><span></span></div>' : '';
        return `${statusBar(st)}${head(curPartner, { back: 'back-msgs' })}
<div class="stp-content"><div class="stp-chat">${msgs || '<div class="stp-empty">첫 메시지를 보내 보세요.</div>'}${dots}</div></div>
<div class="stp-chips">
  <button class="stp-chip" data-act="ai-first">먼저 연락 오게</button>
  <button class="stp-chip" data-act="ai-reply">답장 받기</button>
</div>
<div class="stp-compose">
  <textarea id="stp-chat-input" data-keep="chat" data-enter="send-msg" rows="1" placeholder="메시지 입력"></textarea>
  <button class="stp-send" data-act="send-msg">전송</button>
</div>`;
    }

    function viewFeed(st) {
        const u = userName();
        let posts = st.posts;
        if (feedFilter === 'following') posts = posts.filter(p => p.author === u || follows(st, u, p.author));
        const chip = (f, label) => `<button class="stp-chip ${feedFilter === f ? 'stp-on' : ''}" data-act="feed-filter" data-f="${f}">${label}</button>`;
        const list = posts.map(p => {
            const likeCount = p.likes.length + p.extraLikes;
            const liked = p.likes.includes(u);
            const open = openComments.has(p.id);
            const cms = open ? `<div class="stp-comments">${p.comments.map(c =>
                `<div class="stp-comment"><b>${esc(c.author)}</b>${esc(c.text)}<span>${esc(shortTime(c.time))}</span></div>`).join('') || '<div class="stp-hint">아직 댓글이 없어요.</div>'}
  <div class="stp-cform"><input data-keep="c${p.id}" data-enter="comment-submit" data-id="${p.id}" placeholder="댓글 달기"><button class="stp-btn" data-act="comment-submit" data-id="${p.id}">등록</button></div>
  <div class="stp-acts"><button data-act="react" data-id="${p.id}">✨ AI 반응 받기</button></div></div>` : '';
            return `<div class="stp-post">${avatar(p.author)}<div class="stp-body">
  <div class="stp-who"><b>${esc(p.author)}</b><span>${esc(shortTime(p.time))}</span></div>
  <p>${esc(p.text)}</p>
  ${p.tags.length ? `<div class="stp-tags">${p.tags.map(t => '#' + esc(t)).join(' ')}</div>` : ''}
  <div class="stp-acts">
    <button class="${liked ? 'stp-on' : ''}" data-act="like" data-id="${p.id}">${liked ? '♥' : '♡'} ${likeCount}</button>
    <button data-act="toggle-comments" data-id="${p.id}">💬 ${p.comments.length}</button>
    ${p.author === u ? `<button data-act="del-post" data-id="${p.id}">삭제</button>` : ''}
  </div>${cms}</div></div>`;
        }).join('');
        return `${statusBar(st)}${head('피드', { back: 'home', tools: '<button class="stp-tool" data-act="feed-refresh">새로고침</button>' })}
<div class="stp-content">
  <div class="stp-feedbox">
    <textarea data-keep="post" rows="2" placeholder="지금 무슨 생각을 하고 있나요?"></textarea>
    <div class="stp-row"><div class="stp-switch">${chip('all', '전체')}${chip('following', '팔로잉')}</div><button class="stp-send" data-act="post-submit">게시</button></div>
  </div>
  ${list || '<div class="stp-empty">게시글이 없어요. 새로고침으로 캐릭터들의 글을 불러오세요.</div>'}
</div>`;
    }

    function viewProfiles(st) {
        const u = userName();
        const rows = st.known.map(n => `<div class="stp-card"><div class="stp-line">${avatar(n)}<b style="flex:1;margin-left:10px">${esc(n)}</b></div>
  <div class="stp-line"><label>내가 팔로우</label><input type="checkbox" data-act="follow" data-a="${esc(u)}" data-b="${esc(n)}" ${follows(st, u, n) ? 'checked' : ''}></div>
  <div class="stp-line"><label>${esc(n)}이(가) 나를 팔로우</label><input type="checkbox" data-act="follow" data-a="${esc(n)}" data-b="${esc(u)}" ${follows(st, n, u) ? 'checked' : ''}></div>
</div>`).join('');
        return `${statusBar(st)}${head('프로필', { back: 'home' })}
<div class="stp-content">
  <div class="stp-card"><b>${esc(u)}</b><p class="stp-hint">캐릭터는 자신이 팔로우한 계정의 글만 알 수 있어요.</p></div>
  ${rows || '<div class="stp-empty">아직 알려진 계정이 없어요.</div>'}
</div>`;
    }

    function viewSettings(st) {
        const s = getSettings();
        const chk = (k, label) => `<div class="stp-line"><label for="stp-${k}">${label}</label><input id="stp-${k}" type="checkbox" data-set="${k}" ${s[k] ? 'checked' : ''}></div>`;
        return `${statusBar(st)}${head('설정', { back: 'home' })}
<div class="stp-content">
  <div class="stp-card"><h4>폰 시간</h4>
    <input data-clock value="${esc(st.clock)}" placeholder="YYYY-MM-DD HH:mm">
    <div class="stp-btnrow">
      <button class="stp-btn" data-act="clock-adv" data-min="30">+30분</button>
      <button class="stp-btn" data-act="clock-adv" data-min="60">+1시간</button>
      <button class="stp-btn" data-act="clock-adv" data-min="480">+8시간</button>
      <button class="stp-btn" data-act="clock-adv" data-min="1440">+1일</button>
      <button class="stp-btn" data-act="clock-now">현재 시각</button>
    </div>
    <p class="stp-hint">문자·게시글의 시간이 이 시계를 따라가요.</p>
  </div>
  <div class="stp-card"><h4>자동 모드</h4>
    ${chk('autoMode', '캐릭터가 알아서 폰 활동')}
    <div class="stp-line"><label for="stp-autoEvery">캐릭터 메시지 N개마다 실행</label><input id="stp-autoEvery" type="number" min="1" max="50" data-set="autoEvery" value="${esc(s.autoEvery)}"></div>
    <div class="stp-line"><label for="stp-autoClock">메시지 1개당 폰 시간(분)</label><input id="stp-autoClock" type="number" min="0" max="1440" data-set="autoClock" value="${esc(s.autoClock)}"></div>
    <div class="stp-btnrow"><button class="stp-btn" data-act="auto-now">지금 한 번 실행</button></div>
    <p class="stp-hint">켜 두면 메인 채팅이 진행될 때 캐릭터가 글을 올리고, 먼저 문자를 보내고, 댓글을 달아요. 실행할 때마다 AI 호출이 1번 들어가요.</p>
  </div>
  <div class="stp-card"><h4>연동</h4>
    ${chk('inject', '폰 활동을 메인 채팅에 반영')}
    <div class="stp-line"><label for="stp-injectCount">반영할 최근 활동 수</label><input id="stp-injectCount" type="number" min="1" max="30" data-set="injectCount" value="${esc(s.injectCount)}"></div>
    <div class="stp-line"><label for="stp-maxPosts">게시글 보관 개수</label><input id="stp-maxPosts" type="number" min="20" max="1000" data-set="maxPosts" value="${esc(s.maxPosts)}"></div>
    <div class="stp-line"><label for="stp-maxMessages">상대별 문자 보관 개수</label><input id="stp-maxMessages" type="number" min="20" max="2000" data-set="maxMessages" value="${esc(s.maxMessages)}"></div>
    ${chk('autoReply', '문자 보내면 자동 답장')}
    ${chk('autoReact', '글 올리면 자동 반응')}
  </div>
  <div class="stp-card"><h4>화면</h4>
    <div class="stp-line"><label for="stp-lang">생성 언어</label><select id="stp-lang" data-set="lang">
      ${['한국어', 'English', '日本語'].map(l => `<option ${s.lang === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="stp-line"><label for="stp-accent">포인트 색</label><input id="stp-accent" type="color" data-set="accent" value="${esc(s.accent)}"></div>
  </div>
  <div class="stp-card"><h4>데이터</h4>
    <p class="stp-hint">폰 데이터는 채팅마다 따로 저장돼요.</p>
    <div class="stp-btnrow"><button class="stp-btn stp-danger" data-act="reset-all">이 채팅의 폰 초기화</button></div>
  </div>
</div>`;
    }

    /* ───────────── 이벤트 ───────────── */

    async function onAct(act, el) {
        const st = getState();
        if (!st && act !== 'close') return;
        const u = userName();
        switch (act) {
            case 'close': phoneOpen = false; phoneEl.classList.add('stp-hidden'); return;
            case 'home': view = 'home'; break;
            case 'open': view = el.dataset.app; break;
            case 'back-msgs': view = 'msgs'; break;
            case 'open-chat':
                curPartner = el.dataset.name; view = 'chat'; st.unread[curPartner] = 0; saveState(); break;
            case 'new-chat': {
                const name = (window.prompt('문자를 보낼 상대 이름') || '').trim();
                if (!name || name === u) return;
                registerAccount(st, name);
                st.threads[name] = st.threads[name] || [];
                curPartner = name; view = 'chat'; saveState(); break;
            }
            case 'send-msg': {
                const inp = phoneEl.querySelector('#stp-chat-input');
                const text = inp ? inp.value.trim() : '';
                if (!text) return;
                inp.value = '';
                advance(st, 1);
                addMsg(st, curPartner, u, text);
                saveState(); render();
                if (getSettings().autoReply) await aiSend(curPartner, 'reply');
                return;
            }
            case 'ai-first': await aiSend(curPartner, 'first'); return;
            case 'ai-reply': await aiSend(curPartner, 'reply'); return;
            case 'feed-refresh': await aiPosts(); return;
            case 'auto-now': await aiAuto(true); return;
            case 'feed-filter': feedFilter = el.dataset.f; break;
            case 'post-submit': {
                const inp = phoneEl.querySelector('[data-keep="post"]');
                const text = inp ? inp.value.trim() : '';
                if (!text) return;
                inp.value = '';
                advance(st, 1);
                const p = addPost(st, u, text, []);
                saveState(); render();
                if (getSettings().autoReact) await aiReactions(p.id);
                return;
            }
            case 'like': {
                const p = st.posts.find(x => x.id === +el.dataset.id);
                if (!p) return;
                const i = p.likes.indexOf(u);
                if (i >= 0) p.likes.splice(i, 1); else p.likes.push(u);
                saveState(); break;
            }
            case 'toggle-comments': {
                const id = +el.dataset.id;
                if (openComments.has(id)) openComments.delete(id); else openComments.add(id);
                break;
            }
            case 'comment-submit': {
                const id = +el.dataset.id;
                const inp = phoneEl.querySelector(`[data-keep="c${id}"]`);
                const text = inp ? inp.value.trim() : '';
                const p = st.posts.find(x => x.id === id);
                if (!text || !p) return;
                inp.value = '';
                advance(st, 1);
                p.comments.push({ id: nid(st), author: u, text, time: st.clock });
                saveState(); break;
            }
            case 'react': await aiReactions(+el.dataset.id); return;
            case 'del-post':
                st.posts = st.posts.filter(x => x.id !== +el.dataset.id); saveState(); break;
            case 'follow': {
                const { a, b } = el.dataset;
                st.follows[a] = st.follows[a] || [];
                if (el.checked) addTo(st.follows[a], b); else st.follows[a] = st.follows[a].filter(x => x !== b);
                saveState(); return;
            }
            case 'clock-adv': advance(st, +el.dataset.min); saveState(); break;
            case 'clock-now': st.clock = fmtClock(new Date()); saveState(); break;
            case 'reset-all':
                if (!window.confirm('이 채팅의 폰 데이터(문자·게시글·팔로우)를 모두 지울까요?')) return;
                ctx().chatMetadata[MODULE] = newState();
                openComments.clear(); curPartner = null; view = 'home';
                saveState(); break;
            default: return;
        }
        render();
    }

    function onSet(el) {
        const s = getSettings();
        const k = el.dataset.set;
        if (el.type === 'number') {
            const n = Number(el.value);
            const min = el.min === '' ? 0 : Number(el.min);
            const max = el.max === '' ? 9999 : Number(el.max);
            s[k] = !Number.isFinite(n) ? DEFAULTS[k] : Math.max(min, Math.min(max, Math.trunc(n)));
        } else {
            s[k] = el.type === 'checkbox' ? el.checked : el.value;
        }
        saveSettings();
        refreshInjection();
        render();
    }

    function bindPhone() {
        phoneEl.addEventListener('click', e => {
            const el = e.target.closest('[data-act]');
            if (!el || el.tagName === 'INPUT') return;
            onAct(el.dataset.act, el);
        });
        phoneEl.addEventListener('change', e => {
            const el = e.target;
            if (el.dataset.act === 'follow') { onAct('follow', el); return; }
            if (el.dataset.set) { onSet(el); return; }
            if (el.dataset.clock !== undefined) {
                const st = getState();
                if (st && parseClock(el.value)) { st.clock = fmtClock(parseClock(el.value)); saveState(); render(); }
                else toast('warning', '시간 형식은 YYYY-MM-DD HH:mm 이에요.');
            }
        });
        phoneEl.addEventListener('keydown', e => {
            const act = e.target && e.target.dataset && e.target.dataset.enter;
            if (act && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                onAct(act, e.target);
            }
        });
    }

    /* ── 버블(드래그 + 클릭) ── */

    function clampPos(x, y) {
        return { x: Math.min(Math.max(4, x), window.innerWidth - 56), y: Math.min(Math.max(4, y), window.innerHeight - 56) };
    }
    function placeBubble() {
        const s = getSettings();
        const p = clampPos(...(s.pos ? [s.pos.x, s.pos.y] : [window.innerWidth - 68, window.innerHeight - 150]));
        bubbleEl.style.left = p.x + 'px';
        bubbleEl.style.top = p.y + 'px';
    }
    function bindBubble() {
        let sx, sy, ox, oy, moved = false, down = false;
        bubbleEl.addEventListener('pointerdown', e => {
            down = true; moved = false; sx = e.clientX; sy = e.clientY;
            ox = bubbleEl.offsetLeft; oy = bubbleEl.offsetTop;
            bubbleEl.setPointerCapture(e.pointerId);
        });
        bubbleEl.addEventListener('pointermove', e => {
            if (!down) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 6) return;
            moved = true; bubbleEl.classList.add('stp-dragging');
            const p = clampPos(ox + dx, oy + dy);
            bubbleEl.style.left = p.x + 'px'; bubbleEl.style.top = p.y + 'px';
        });
        const finishPointer = (cancelled = false) => {
            if (!down) return;
            down = false; bubbleEl.classList.remove('stp-dragging');
            if (moved) {
                getSettings().pos = { x: bubbleEl.offsetLeft, y: bubbleEl.offsetTop };
                saveSettings();
            } else if (!cancelled) togglePhone();
        };
        bubbleEl.addEventListener('pointerup', () => finishPointer(false));
        bubbleEl.addEventListener('pointercancel', () => finishPointer(true));
        bubbleEl.addEventListener('lostpointercapture', () => finishPointer(true));
        window.addEventListener('resize', placeBubble);
    }

    function togglePhone() {
        phoneOpen = !phoneOpen;
        phoneEl.classList.toggle('stp-hidden', !phoneOpen);
        if (phoneOpen) render();
    }

    /* ── 확장 설정 패널 ── */

    function mountSettingsPanel() {
        const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!host || document.getElementById('stp-drawer')) return;
        const s = getSettings();
        const wrap = document.createElement('div');
        wrap.id = 'stp-drawer';
        wrap.innerHTML = `<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header"><b>ST Phone</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input id="stp_enabled" type="checkbox" ${s.enabled ? 'checked' : ''}><span>폰 버블 사용</span></label>
    <small>버블을 눌러 폰을 열고, 길게 끌어서 위치를 옮길 수 있어요. 세부 설정은 폰의 ⚙️ 설정 앱에 있어요.</small>
  </div></div>`;
        host.appendChild(wrap);
        wrap.querySelector('#stp_enabled').addEventListener('change', e => {
            getSettings().enabled = e.target.checked;
            saveSettings();
            if (!e.target.checked && phoneOpen) togglePhone();
            refreshInjection();
            render();
        });
    }

    /* ── 초기화 ── */

    function init() {
        if (document.getElementById('stp-bubble')) return;
        bubbleEl = document.createElement('div');
        bubbleEl.id = 'stp-bubble';
        bubbleEl.innerHTML = '📱<span class="stp-badge"></span>';
        phoneEl = document.createElement('div');
        phoneEl.id = 'stp-phone';
        phoneEl.className = 'stp-hidden';
        document.body.append(bubbleEl, phoneEl);
        placeBubble();
        bindBubble();
        bindPhone();
        mountSettingsPanel();

        const { eventSource, eventTypes } = ctx();
        eventSource.on(eventTypes.CHAT_CHANGED, () => {
            view = 'home'; curPartner = null; typing = null; openComments.clear();
            getState();
            refreshInjection();
            render();
        });
        eventSource.on(eventTypes.MESSAGE_RECEIVED, onCharMessage);
        render();
        refreshInjection();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
