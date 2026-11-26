// Sylva's built-in widgets: custom code widgets in StreamElements' format,
// ready to edit like any other.

import type { CustomCode } from '../api';
import pillHtml from './pill-alerts.html?raw';
import pillCss from './pill-alerts.css?raw';
import pillJs from './pill-alerts.js?raw';
import pillFields from './pill-alerts.json?raw';
import chatHtml from './twitch-chat.html?raw';
import chatCss from './twitch-chat.css?raw';
import chatJs from './twitch-chat.js?raw';
import chatFields from './twitch-chat.json?raw';

/** Alerts as a black pill that opens from a circle. Plays the alert queue. */
export const PILL_ALERTS: CustomCode = {
  name: 'Pill alerts', html: pillHtml, css: pillCss, js: pillJs, fields: pillFields, values: {}, alerts: true,
};

/** Chat the way Twitch shows it, with badges and Twitch, 7TV, BetterTTV and FrankerFaceZ emotes. */
export const TWITCH_CHAT: CustomCode = {
  name: 'Chat', html: chatHtml, css: chatCss, js: chatJs, fields: chatFields, values: {}, alerts: false,
};
