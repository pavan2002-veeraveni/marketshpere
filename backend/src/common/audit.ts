import { Prisma, PrismaClient } from '@prisma/client';

export interface AuditInput {
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId?: string | null;
  ipAddress?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
}

export async function recordAuditLog(
  client: PrismaClient | Prisma.TransactionClient,
  input: AuditInput,
): Promise<void> {
  await client.auditLog.create({
    data: {
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
      beforeState: input.beforeState !== undefined ? (input.beforeState as Prisma.InputJsonValue) : undefined,
      afterState: input.afterState !== undefined ? (input.afterState as Prisma.InputJsonValue) : undefined,
    },
  });
}
