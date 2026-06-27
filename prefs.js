import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeUsagePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Claude Usage',
            icon_name: 'utilities-system-monitor-symbolic',
        });
        window.add(page);

        // --- Группа: отображение ---
        const display = new Adw.PreferencesGroup({title: 'Отображение'});
        page.add(display);

        const modeRow = new Adw.ComboRow({
            title: 'Что показывать в панели',
            subtitle: 'Оба числа (5ч · 7д) или только наибольшее',
            model: new Gtk.StringList({strings: ['Оба (5ч · 7д)', 'Только максимум']}),
        });
        modeRow.set_selected(settings.get_string('panel-mode') === 'max' ? 1 : 0);
        modeRow.connect('notify::selected', () => {
            settings.set_string('panel-mode', modeRow.get_selected() === 1 ? 'max' : 'both');
        });
        display.add(modeRow);

        // --- Группа: обновление ---
        const upd = new Adw.PreferencesGroup({title: 'Обновление'});
        page.add(upd);

        const intervalRow = new Adw.SpinRow({
            title: 'Интервал опроса (минуты)',
            subtitle: 'Ниже 3 минут возможны ошибки 429',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 120, step_increment: 1, page_increment: 5}),
        });
        intervalRow.set_value(settings.get_int('refresh-interval'));
        intervalRow.connect('notify::value', () => {
            settings.set_int('refresh-interval', intervalRow.get_value());
        });
        upd.add(intervalRow);

        const manualRow = new Adw.SwitchRow({
            title: 'Ручное первое обновление',
            subtitle: 'Не опрашивать API при входе в систему',
        });
        settings.bind('manual-first', manualRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        upd.add(manualRow);

        // --- Группа: VPN / выходная нода ---
        const vpn = new Adw.PreferencesGroup({
            title: 'Проверка VPN-ноды',
            description: 'Если задана страна, перед каждым запросом проверяется выходная нода. ' +
                'При несовпадении запрос не отправляется — защита от утечки через реальный IP. ' +
                'Код страны Mullvad смотри в приложении (Netherlands → NL, Germany → DE, Sweden → SE).',
        });
        page.add(vpn);

        const countryRow = new Adw.EntryRow({
            title: 'Ожидаемая страна (ISO-код, пусто = выкл)',
        });
        countryRow.set_text(settings.get_string('expected-country'));
        countryRow.connect('changed', () => {
            settings.set_string('expected-country', countryRow.get_text().trim().toUpperCase());
        });
        vpn.add(countryRow);

        // --- Группа: дополнительно ---
        const adv = new Adw.PreferencesGroup({title: 'Дополнительно'});
        page.add(adv);

        const pathRow = new Adw.EntryRow({
            title: 'Путь к credentials.json (пусто = авто)',
        });
        pathRow.set_text(settings.get_string('credentials-path'));
        pathRow.connect('changed', () => {
            settings.set_string('credentials-path', pathRow.get_text().trim());
        });
        adv.add(pathRow);
    }
}
