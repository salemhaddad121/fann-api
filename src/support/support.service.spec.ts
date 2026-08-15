import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SupportService } from './support.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

function makeEmail() {
  return {
    sendSupportTicketEmail: jest.fn().mockResolvedValue(undefined),
    sendSupportReplyEmail: jest.fn().mockResolvedValue(undefined),
  };
}

const config = { get: jest.fn(() => 'support@fann.app') };

function makeService(
  builders: Record<string, ReturnType<typeof createMockQueryBuilder>>,
  email = makeEmail(),
) {
  const service = new SupportService(
    createMockDb(builders),
    email as any,
    config as any,
  );
  return { service, email };
}

function ticketBuilder() {
  const tickets = createMockQueryBuilder();
  tickets.returning.mockResolvedValueOnce([
    { id: 'ticket-1', subject: 'Help', status: 'open', created_at: new Date() },
  ]);
  return tickets;
}

const baseDto = {
  subject: 'Cannot log in',
  body: 'I never received the verification email.',
} as any;

describe('SupportService.create()', () => {
  it('refuses a guest ticket with no address', async () => {
    // A ticket nobody can reply to is worse than no ticket — the person
    // waits for an answer that can never arrive.
    const { service } = makeService({ support_tickets: ticketBuilder() });

    await expect(service.create({}, baseDto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a guest ticket that carries an address', async () => {
    const tickets = ticketBuilder();
    const { service } = makeService({
      support_tickets: tickets,
      support_ticket_messages: createMockQueryBuilder(),
    });

    await service.create({}, { ...baseDto, guestEmail: 'guest@example.com' });

    expect(tickets.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: null, guest_email: 'guest@example.com' }),
    );
  });

  it('ignores a guest address supplied by a signed-in user', async () => {
    // Otherwise a signed-in user could file tickets that appear to come
    // from someone else's address.
    const tickets = ticketBuilder();
    const { service } = makeService({
      support_tickets: tickets,
      support_ticket_messages: createMockQueryBuilder(),
    });

    await service.create(
      { userId: 'user-1', email: 'real@example.com' },
      { ...baseDto, guestEmail: 'someone.else@example.com' },
    );

    expect(tickets.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', guest_email: null }),
    );
  });

  it('stores the opening message in the thread as well as on the ticket', async () => {
    // So a reply thread reads from the beginning rather than starting
    // mid-conversation.
    const messages = createMockQueryBuilder();
    const { service } = makeService({
      support_tickets: ticketBuilder(),
      support_ticket_messages: messages,
    });

    await service.create({ userId: 'user-1' }, baseDto);

    expect(messages.insert).toHaveBeenCalledWith(
      expect.objectContaining({ ticket_id: 'ticket-1', is_staff: false, body: baseDto.body }),
    );
  });

  it('still saves the ticket when the inbox email fails', async () => {
    // The row is the source of truth; the notification is a convenience.
    // Reporting failure would make someone retype a message we already have.
    const email = makeEmail();
    email.sendSupportTicketEmail.mockRejectedValueOnce(new Error('resend down'));
    const { service } = makeService(
      {
        support_tickets: ticketBuilder(),
        support_ticket_messages: createMockQueryBuilder(),
      },
      email,
    );

    await expect(service.create({ userId: 'user-1' }, baseDto)).resolves.toMatchObject({
      id: 'ticket-1',
    });
  });
});

describe('SupportService.update()', () => {
  /**
   * update() reads the ticket unaliased, then calls getOne(), which reads
   * it as `support_tickets as t` and the thread as
   * `support_ticket_messages as m`. The mock resolves builders by the exact
   * string passed to db(), so the aliased names need their own entries or
   * getOne() gets a fresh builder and throws NotFound.
   */
  function updateSetup(existing: Record<string, unknown>) {
    const tickets = createMockQueryBuilder();
    tickets.first.mockResolvedValue(existing);

    const ticketsAliased = createMockQueryBuilder();
    ticketsAliased.first.mockResolvedValue(existing);

    const messages = createMockQueryBuilder();
    const messagesAliased = createMockQueryBuilder();
    messagesAliased.mockResolve([]);

    return {
      tickets,
      messages,
      builders: {
        support_tickets: tickets,
        'support_tickets as t': ticketsAliased,
        support_ticket_messages: messages,
        'support_ticket_messages as m': messagesAliased,
      },
    };
  }

  it('rejects a ticket that does not exist', async () => {
    const tickets = createMockQueryBuilder();
    tickets.first.mockResolvedValueOnce(undefined);
    const { service } = makeService({ support_tickets: tickets });

    await expect(
      service.update('admin-1', 'nope', { status: 'closed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stamps resolved_at when a ticket is resolved', async () => {
    const { tickets, builders } = updateSetup({
      id: 'ticket-1',
      resolved_at: null,
      user_id: null,
      guest_email: 'g@example.com',
      subject: 'Help',
    });
    const { service } = makeService(builders);

    await service.update('admin-1', 'ticket-1', { status: 'resolved' });

    const patch = tickets.update.mock.calls[0][0];
    expect(patch.status).toBe('resolved');
    expect(patch.resolved_at).toBeTruthy();
  });

  it('does not rewrite the original resolution time on a re-resolve', async () => {
    const originallyResolved = new Date('2026-08-01T10:00:00Z');
    const { tickets, builders } = updateSetup({
      id: 'ticket-1',
      resolved_at: originallyResolved,
      user_id: null,
      guest_email: 'g@example.com',
      subject: 'Help',
    });
    const { service } = makeService(builders);

    await service.update('admin-1', 'ticket-1', { status: 'closed' });

    expect(tickets.update.mock.calls[0][0].resolved_at).toBe(originallyResolved);
  });

  it('clears resolved_at when a ticket is reopened', async () => {
    const { tickets, builders } = updateSetup({
      id: 'ticket-1',
      resolved_at: new Date(),
      user_id: null,
      guest_email: 'g@example.com',
      subject: 'Help',
    });
    const { service } = makeService(builders);

    await service.update('admin-1', 'ticket-1', { status: 'open' });

    expect(tickets.update.mock.calls[0][0].resolved_at).toBeNull();
  });

  it('appends a staff reply and emails the guest who raised it', async () => {
    const { messages, builders } = updateSetup({
      id: 'ticket-1',
      resolved_at: null,
      user_id: null,
      guest_email: 'guest@example.com',
      subject: 'Help',
    });
    const { service, email } = makeService(builders);

    await service.update('admin-1', 'ticket-1', { reply: 'Try the reset link.' });

    expect(messages.insert).toHaveBeenCalledWith(
      expect.objectContaining({ is_staff: true, author_id: 'admin-1' }),
    );
    expect(email.sendSupportReplyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'guest@example.com' }),
    );
  });
});
