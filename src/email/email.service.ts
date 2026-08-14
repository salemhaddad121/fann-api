import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly configService: ConfigService) {}

  // ----------------------------------------------------------------
  // Low-level send — every template method below funnels through here.
  //
  // Deliberately does NOT throw on failure. Email is a side effect of
  // registration and the daily review-request cron; a Resend outage
  // shouldn't 500 a signup or crash the scheduler run. Failures are
  // logged so they show up in monitoring instead.
  // ----------------------------------------------------------------
  async send({ to, subject, html }: SendEmailInput): Promise<void> {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    const from   = this.configService.get<string>('EMAIL_FROM') ?? 'noreply@fann.app';

    if (!apiKey) {
      // No provider configured yet (e.g. local dev) — log instead of failing silently.
      this.logger.warn(`RESEND_API_KEY not set — logging email instead of sending to ${to}`);
      this.logger.log(`[DEV EMAIL] To: ${to} | Subject: ${subject}\n${html}`);
      return;
    }

    let response: any;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, html }),
      });
    } catch (err) {
      this.logger.error(`Network error sending email to ${to}`, err as Error);
      return;
    }

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Resend rejected email to ${to}: ${response.status} ${body}`);
    }
  }

  // ----------------------------------------------------------------
  // Templates
  // ----------------------------------------------------------------

  async sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
    await this.send({
      to,
      subject: 'Verify your Fann account',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
          <h2 style="color:#3C3489;">Welcome to Fann</h2>
          <p>Confirm your email address to activate your account.</p>
          <p>
            <a href="${verifyUrl}"
               style="display:inline-block;padding:12px 24px;background:#3C3489;color:#fff;
                      text-decoration:none;border-radius:6px;font-weight:bold;">
              Verify email
            </a>
          </p>
          <p style="font-size:13px;color:#666;">Or copy this link into your browser:<br>${verifyUrl}</p>
          <p style="font-size:13px;color:#666;">If you didn't create a Fann account, you can ignore this email.</p>
        </div>
      `,
    });
  }

  // Renewal warning. Deliberately worded as "renew" rather than "you will
  // be charged": every renewal is a fresh purchase the buyer approves, not
  // an automatic charge, because neither of the local payment services
  // supports stored credentials or recurring mandates.
  async sendSubscriptionExpiringEmail(input: {
    to: string;
    recipientName: string;
    planCode: string;
    daysLeft: number;
    expiresAt: Date;
    renewUrl: string;
  }): Promise<void> {
    const { to, recipientName, planCode, daysLeft, expiresAt, renewUrl } = input;
    const when = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;

    await this.send({
      to,
      subject: `Your Fann ${planCode} plan ends ${when}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
          <h2 style="color:#3C3489;">Your ${planCode} plan ends ${when}</h2>
          <p>Hi ${recipientName},</p>
          <p>
            Your Fann ${planCode} subscription ends on
            <strong>${new Date(expiresAt).toDateString()}</strong>. After that you'll
            still be able to browse, but artist contact details and messaging will be locked.
          </p>
          <p>
            <a href="${renewUrl}"
               style="display:inline-block;padding:12px 24px;background:#3C3489;color:#fff;
                      text-decoration:none;border-radius:6px;font-weight:bold;">
              Renew now
            </a>
          </p>
          <p style="font-size:13px;color:#666;">
            Nothing is charged automatically — renewing is a new purchase you confirm yourself.
          </p>
        </div>
      `,
    });
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    await this.send({
      to,
      subject: 'Reset your Fann password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
          <h2 style="color:#3C3489;">Reset your password</h2>
          <p>We received a request to reset your Fann account password.</p>
          <p>
            <a href="${resetUrl}"
               style="display:inline-block;padding:12px 24px;background:#3C3489;color:#fff;
                      text-decoration:none;border-radius:6px;font-weight:bold;">
              Reset password
            </a>
          </p>
          <p style="font-size:13px;color:#666;">Or copy this link into your browser:<br>${resetUrl}</p>
          <p style="font-size:13px;color:#666;">
            This link expires in 1 hour. If you didn't request this, you can safely ignore this email —
            your password won't be changed.
          </p>
        </div>
      `,
    });
  }

  async sendReviewRequestEmail(input: {
    to: string;
    recipientName: string;
    eventName: string;
    eventDate: string;
    reviewUrl: string;
    deadlineDays: number;
    questions: string[];
  }): Promise<void> {
    const { to, recipientName, eventName, eventDate, reviewUrl, deadlineDays, questions } = input;

    await this.send({
      to,
      subject: `How did "${eventName}" go? Leave a review`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
          <h2 style="color:#3C3489;">How did "${eventName}" go?</h2>
          <p>Hi ${recipientName},</p>
          <p>Event date: ${eventDate}</p>
          <p>
            We'd love to hear how it went. Your review stays hidden until the other
            party submits theirs too, or after ${deadlineDays} days — whichever comes first.
          </p>
          <ul>
            ${questions.map((q) => `<li>${q}</li>`).join('')}
          </ul>
          <p>
            <a href="${reviewUrl}"
               style="display:inline-block;padding:12px 24px;background:#3C3489;color:#fff;
                      text-decoration:none;border-radius:6px;font-weight:bold;">
              Leave a review
            </a>
          </p>
        </div>
      `,
    });
  }
}
