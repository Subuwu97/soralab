// Suite notifications (Mirai Account's bell and push): exports finished, projects shared, review comments.
import { config } from './config.js';
import { makeNotifier } from '../../suite/notify.js';

export const notifier = makeNotifier({ accountsUrl: config.accountsInternalUrl, clientId: config.clientId, clientSecret: config.clientSecret });
