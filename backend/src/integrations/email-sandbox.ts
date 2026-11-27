import { logger } from '../common/logger';

export interface SandboxEmailMessage {
  to: string;
  subject: string;
  body: string;
  template: string;
  requestId?: string;
}

const recentEmailLog: Array<SandboxEmailMessage & { sentAt: string }> = [];

export const emailSandboxAdapter = {
  async sendEmail(message: SandboxEmailMessage): Promise<{ messageId: string; status: 'SENT_SANDBOX' }> {
    const messageId = `mail_sbx_${Date.now()}`;
    recentEmailLog.unshift({ ...message, sentAt: new Date().toISOString() });
    if (recentEmailLog.length > 100) recentEmailLog.pop();
    logger.info(
      { requestId: message.requestId, to: message.to, template: message.template, messageId },
      'Sent sandbox email notification',
    );
    return { messageId, status: 'SENT_SANDBOX' };
  },

  getRecentSandboxEmails() {
    return recentEmailLog;
  },
};
