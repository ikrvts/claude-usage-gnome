/* Claude Usage — GNOME Shell extension
 * Показывает лимиты подписки Claude (5h / 7d) в верхней панели.
 * Лицензия: MIT
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TRACE_URL = 'https://api.anthropic.com/cdn-cgi/trace';
const BAR_WIDTH = 240; // px, ширина трека прогресс-бара в поп-апе

// Пороги для цвета (по наибольшему из лимитов)
const COLOR_OK = '#3fb950';   // зелёный  < 60%
const COLOR_WARN = '#d29922'; // жёлтый   60–85%
const COLOR_CRIT = '#f85149'; // красный  > 85%
const COLOR_IDLE = '#8b949e'; // серый    нет данных

function colorFor(pct) {
    if (pct == null || isNaN(pct))
        return COLOR_IDLE;
    if (pct > 85)
        return COLOR_CRIT;
    if (pct >= 60)
        return COLOR_WARN;
    return COLOR_OK;
}

// Привести utilization к целому проценту 0..100 (API может отдавать 0..1 или 0..100)
function toPercent(v) {
    if (typeof v !== 'number' || isNaN(v))
        return null;
    let pct = v <= 1 ? v * 100 : v;
    return Math.max(0, Math.min(100, Math.round(pct)));
}

// Достать reset-время из объекта лимита (имя поля точно не задокументировано — пробуем варианты)
function resetMillis(obj) {
    if (!obj || typeof obj !== 'object')
        return null;
    const raw = obj.resets_at ?? obj.reset_at ?? obj.resetsAt ?? obj.reset ?? null;
    if (raw == null)
        return null;
    if (typeof raw === 'number') {
        // секунды или миллисекунды
        return raw < 1e12 ? raw * 1000 : raw;
    }
    const t = Date.parse(raw);
    return isNaN(t) ? null : t;
}

// "через 2 ч 13 мин" / "сейчас"
function humanReset(ms) {
    if (ms == null)
        return null;
    let diff = ms - Date.now();
    if (diff <= 0)
        return 'сброс вот-вот';
    const totalMin = Math.round(diff / 60000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    let parts = [];
    if (d > 0) parts.push(`${d} д`);
    if (h > 0) parts.push(`${h} ч`);
    if (m > 0 && d === 0) parts.push(`${m} мин`);
    return 'сброс через ' + (parts.join(' ') || '< 1 мин');
}

// ----- Виджет прогресс-бара (трек + заливка) -----
function makeBar(pct) {
    const track = new St.Widget({
        style_class: 'claude-bar-track',
        width: BAR_WIDTH,
        height: 8,
        layout_manager: new Clutter.BinLayout(),
        x_expand: false,
    });
    const fillW = pct == null ? 0 : Math.round(BAR_WIDTH * pct / 100);
    const fill = new St.Widget({
        style_class: 'claude-bar-fill',
        width: Math.max(0, fillW),
        height: 8,
        x_align: Clutter.ActorAlign.START,
        style: `background-color: ${colorFor(pct)};`,
    });
    track.add_child(fill);
    return track;
}

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Claude Usage');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._session = new Soup.Session();
        this._session.timeout = 20;
        this._cancellable = new Gio.Cancellable();
        this._timeoutId = 0;
        this._notifiedNode = false; // чтобы не спамить уведомлениями о ноде
        this._data = null;

        // --- Панель: цветная точка + текст ---
        const box = new St.BoxLayout({style_class: 'claude-panel-box'});
        this._dot = new St.Label({
            text: '\u25CF', // ●
            style_class: 'claude-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            text: '…',
            style_class: 'claude-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._dot);
        box.add_child(this._label);
        this.add_child(box);
        this._setDotColor(COLOR_IDLE);

        this._buildMenu();

        // Реакция на смену настроек панели
        this._settings.connect('changed::panel-mode', () => this._renderPanel());

        // Старт
        const interval = Math.max(1, this._settings.get_int('refresh-interval'));
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval * 60, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });

        if (!this._settings.get_boolean('manual-first'))
            this._refresh();
        else
            this._label.set_text('—');
    }

    _setDotColor(hex) {
        this._dot.set_style(`color: ${hex};`);
    }

    _buildMenu() {
        // Заголовок
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const hbox = new St.BoxLayout({style_class: 'claude-header', x_expand: true});
        const title = new St.Label({text: 'Claude', style_class: 'claude-title', x_expand: true});
        this._plan = new St.Label({text: '', style_class: 'claude-plan', y_align: Clutter.ActorAlign.CENTER});
        hbox.add_child(title);
        hbox.add_child(this._plan);
        header.add_child(hbox);
        this.menu.addMenuItem(header);

        // Блок 5 часов
        this._row5h = this._makeLimitRow('5 часов');
        this.menu.addMenuItem(this._row5h.item);

        // Блок 7 дней
        this._row7d = this._makeLimitRow('7 дней');
        this.menu.addMenuItem(this._row7d.item);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Статус-строка (обновлено / ошибка)
        const statusItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._status = new St.Label({text: 'Нет данных', style_class: 'claude-status', x_expand: true});
        statusItem.add_child(this._status);
        this.menu.addMenuItem(statusItem);

        // Обновить
        const refreshItem = new PopupMenu.PopupMenuItem('Обновить');
        refreshItem.connect('activate', () => this._refresh(true));
        this.menu.addMenuItem(refreshItem);

        // Настройки
        const prefsItem = new PopupMenu.PopupMenuItem('Настройки');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _makeLimitRow(name) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'claude-limit'});

        const top = new St.BoxLayout({x_expand: true});
        const nameLabel = new St.Label({text: name, style_class: 'claude-limit-name', x_expand: true});
        const pctLabel = new St.Label({text: '—', style_class: 'claude-limit-pct'});
        top.add_child(nameLabel);
        top.add_child(pctLabel);

        const barHolder = new St.Bin({style_class: 'claude-bar-holder', x_align: Clutter.ActorAlign.START});
        barHolder.set_child(makeBar(null));

        const reset = new St.Label({text: '', style_class: 'claude-reset'});

        col.add_child(top);
        col.add_child(barHolder);
        col.add_child(reset);
        item.add_child(col);

        return {item, pctLabel, barHolder, reset};
    }

    // ---------- Сетевой цикл ----------

    _refresh(manual = false) {
        const expected = this._settings.get_string('expected-country').trim().toUpperCase();
        if (expected) {
            // Сначала проверяем выходную ноду
            this._checkNode(expected, (ok, actual) => {
                if (!ok) {
                    if (!this._notifiedNode || manual) {
                        Main.notify('Claude Usage',
                            `Запрос пропущен: выход через ${actual || '?'}, ожидалось ${expected}. Проверь VPN.`);
                        this._notifiedNode = true;
                    }
                    this._setError(`нода ${actual || '?'} ≠ ${expected}`);
                    return;
                }
                this._notifiedNode = false;
                this._fetchUsage(manual);
            });
        } else {
            this._fetchUsage(manual);
        }
    }

    _checkNode(expected, cb) {
        const msg = Soup.Message.new('GET', TRACE_URL);
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const text = new TextDecoder().decode(bytes.get_data());
                    const m = text.match(/loc=([A-Z]{2})/);
                    const actual = m ? m[1] : null;
                    cb(actual === expected, actual);
                } catch (e) {
                    // Не удалось проверить — безопаснее не отправлять
                    cb(false, null);
                }
            });
    }

    _readToken() {
        let path = this._settings.get_string('credentials-path').trim();
        if (!path)
            path = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);

        const file = Gio.File.new_for_path(path);
        return new Promise((resolve, reject) => {
            file.load_contents_async(this._cancellable, (f, res) => {
                try {
                    const [ok, contents] = f.load_contents_finish(res);
                    if (!ok)
                        throw new Error('не прочитан');
                    const json = JSON.parse(new TextDecoder().decode(contents));
                    const oauth = json.claudeAiOauth ?? json;
                    const token = oauth.accessToken ?? json.accessToken;
                    if (!token)
                        throw new Error('нет accessToken');
                    const exp = oauth.expiresAt ?? null;
                    const plan = oauth.subscriptionType ?? null;
                    resolve({token, exp, plan});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _fetchUsage(manual) {
        let cred;
        try {
            cred = await this._readToken();
        } catch (e) {
            this._setError('нет токена');
            if (manual)
                Main.notify('Claude Usage', 'Не удалось прочитать ~/.claude/.credentials.json. Залогинься в Claude Code.');
            return;
        }

        if (cred.exp && Date.now() > cred.exp) {
            this._setError('токен истёк');
            if (manual)
                Main.notify('Claude Usage', 'Токен истёк. Запусти claude в терминале, чтобы обновить сессию.');
            return;
        }

        this._lastPlan = cred.plan;

        const msg = Soup.Message.new('GET', USAGE_URL);
        const h = msg.request_headers;
        h.append('Authorization', `Bearer ${cred.token}`);
        h.append('anthropic-beta', 'oauth-2025-04-20');
        h.append('anthropic-version', '2023-06-01');
        h.append('User-Agent', 'claude-usage-gnome/1.0');
        h.append('Accept', 'application/json');

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const status = msg.get_status();
                    const text = new TextDecoder().decode(bytes.get_data());

                    if (status === Soup.Status.TOO_MANY_REQUESTS || status === 429) {
                        this._setError('429 — слишком часто');
                        return;
                    }
                    if (status === Soup.Status.UNAUTHORIZED || status === 401) {
                        this._setError('401 — токен отклонён');
                        if (manual)
                            Main.notify('Claude Usage', 'API вернул 401. Возможно, токен устарел — перелогинься в Claude Code.');
                        return;
                    }
                    if (status !== Soup.Status.OK && status !== 200) {
                        this._setError(`HTTP ${status}`);
                        return;
                    }

                    const data = JSON.parse(text);
                    this._applyData(data);
                } catch (e) {
                    this._setError('ошибка ответа');
                    if (manual)
                        Main.notify('Claude Usage', `Не разобрал ответ API: ${e.message}`);
                }
            });
    }

    // ---------- Применение данных к UI ----------

    _applyData(data) {
        const fh = data.five_hour ?? data.fiveHour ?? {};
        const sd = data.seven_day ?? data.sevenDay ?? {};

        const p5 = toPercent(fh.utilization);
        const p7 = toPercent(sd.utilization);

        this._data = {
            p5, p7,
            r5: resetMillis(fh),
            r7: resetMillis(sd),
        };

        // Строка 5h
        this._row5h.pctLabel.set_text(p5 == null ? '—' : `${p5}%`);
        this._row5h.pctLabel.set_style(`color: ${colorFor(p5)};`);
        this._row5h.barHolder.set_child(makeBar(p5));
        const hr5 = humanReset(this._data.r5);
        this._row5h.reset.set_text(hr5 ?? '');

        // Строка 7d
        this._row7d.pctLabel.set_text(p7 == null ? '—' : `${p7}%`);
        this._row7d.pctLabel.set_style(`color: ${colorFor(p7)};`);
        this._row7d.barHolder.set_child(makeBar(p7));
        const hr7 = humanReset(this._data.r7);
        this._row7d.reset.set_text(hr7 ?? '');

        // План
        if (this._lastPlan)
            this._plan.set_text(this._lastPlan.toUpperCase());

        // Статус
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        this._status.set_text(`Обновлено ${hh}:${mm}`);

        this._renderPanel();
    }

    _renderPanel() {
        if (!this._data) {
            this._label.set_text('…');
            this._setDotColor(COLOR_IDLE);
            return;
        }
        const {p5, p7} = this._data;
        const worst = Math.max(p5 ?? 0, p7 ?? 0);
        this._setDotColor(colorFor(worst));

        const mode = this._settings.get_string('panel-mode');
        if (mode === 'max') {
            this._label.set_text(`${worst}%`);
        } else {
            const a = p5 == null ? '—' : `${p5}%`;
            const b = p7 == null ? '—' : `${p7}%`;
            this._label.set_text(`${a} · ${b}`);
        }
    }

    _setError(msg) {
        this._setDotColor(COLOR_CRIT);
        this._label.set_text('!');
        this._status.set_text(msg);
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new ClaudeIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
