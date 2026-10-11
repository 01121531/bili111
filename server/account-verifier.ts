import { AppDatabase, AccountRow } from './db';
import { decrypt } from './security';
import { verifyBiliCookie } from './bili';
import { EmailNotificationService } from './notifications';

export class AccountVerifier {
  private running = false;
  constructor(private db: AppDatabase, private notifications: EmailNotificationService, private acquireQueue: () => boolean = () => true, private releaseQueue: () => void = () => undefined, private verifyCookie = verifyBiliCookie) {}

  async verify(account: AccountRow) {
    const result = await this.verifyCookie(decrypt(account.cookie));
    const verifiedAt = this.db.now();
    if (result.ok) {
      const wasInvalid = account.cookie_status === 'invalid';
      const updated = this.db.updateAccountCookie(account.id, account.cookie, result.profile)!;
      if (wasInvalid) void this.notifications.notifyRecovery(updated).catch(() => undefined);
      return { id: account.id, ok: true, status: 'valid', profile: result.profile };
    }

    if (result.kind === 'invalid') {
      this.db.updateAccount(account.id, { cookieStatus: 'invalid', verificationError: result.error, verifiedAt });
      void this.notifications.notifyInvalid(this.db.getAccount(account.id)!, result.error).catch(() => undefined);
      return { id: account.id, ok: false, status: 'invalid', error: result.error };
    }

    this.db.updateAccount(account.id, { verificationError: result.error, verifiedAt });
    return { id: account.id, ok: false, status: account.cookie_status, transient: true, error: result.error };
  }

  async verifyOne(id: number) {
    const account = this.db.getAccount(id);
    if (!account) return undefined;
    if (!this.acquireQueue()) return { id, ok: false as const, busy: true, status: account.cookie_status, error: '账号任务队列正在运行' };
    try { return await this.verify(account); } finally { this.releaseQueue(); }
  }

  async verifyAll(status?: string) {
    if (this.running) return { running: true, results: [] };
    if (!this.acquireQueue()) return { running: false, busy: true, results: [] };
    this.running = true;
    const accounts = status ? this.db.listAccountsByStatus(status) : this.db.listAccounts().map(row => this.db.getAccount(row.id)!).filter(Boolean);
    const results: Array<Record<string, unknown>> = [];
    try {
      for (const account of accounts) {
        results.push(await this.verify(account));
        await new Promise(resolve => setTimeout(resolve, 350));
      }
      return { running: false, results };
    } finally { this.running = false; this.releaseQueue(); }
  }
}
