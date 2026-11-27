import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { RoleName, UserStatus } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../common/prisma';
import { recordAuditLog } from '../../common/audit';
import { emailSandboxAdapter } from '../../integrations/email-sandbox';
import { ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from '../../common/errors';
import { authRepository } from './auth.repository';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseDurationMs(spec: string, fallbackMs: number): number {
  const match = spec.match(/^(\d+)([smhd])$/);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60 * 1000;
  if (unit === 'h') return amount * 60 * 60 * 1000;
  if (unit === 'd') return amount * 24 * 60 * 60 * 1000;
  return fallbackMs;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) +
    '-' +
    crypto.randomBytes(3).toString('hex')
  );
}

function signAccessToken(userId: string, email: string, roles: RoleName[]): string {
  return jwt.sign(
    { sub: userId, email, roles, type: 'access' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  );
}

function sanitizeUser(user: NonNullable<Awaited<ReturnType<typeof authRepository.findUserById>>>) {
  const roles = Array.from(new Set([user.primaryRole, ...user.userRoles.map((ur) => ur.role.name)]));
  const permissions = Array.from(
    new Set(user.userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.code))),
  );
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    status: user.status,
    primaryRole: user.primaryRole,
    roles,
    permissions,
    seller: user.seller,
    createdAt: user.createdAt,
  };
}

export const authService = {
  async register(
    input: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      phone?: string;
      accountType: 'CUSTOMER' | 'SELLER';
      storeName?: string;
    },
    meta: { requestId?: string; ipAddress?: string; userAgent?: string },
  ) {
    const existing = await authRepository.findUserByEmail(input.email);
    if (existing) {
      throw new ConflictError('An account with this email already exists', 'EMAIL_ALREADY_EXISTS');
    }

    if (input.accountType === 'SELLER' && !input.storeName) {
      throw new ValidationError('Store name is required when registering as a seller', [
        { path: 'body.storeName', message: 'Store name is required' },
      ]);
    }

    const passwordHash = await bcrypt.hash(input.password, 12);
    const primaryRole = input.accountType === 'SELLER' ? RoleName.SELLER : RoleName.CUSTOMER;
    const storeSlug = input.storeName ? slugify(input.storeName) : undefined;

    const { user } = await authRepository.createUserAccount({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      primaryRole,
      storeName: input.storeName,
      storeSlug,
    });

    const fullUser = await authRepository.findUserById(user.id);
    const sanitized = sanitizeUser(fullUser!);

    const rawRefreshToken = crypto.randomBytes(48).toString('hex');
    const familyId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN, 7 * 86400_000));

    await authRepository.createRefreshToken({
      userId: user.id,
      tokenHash: sha256(rawRefreshToken),
      familyId,
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    await recordAuditLog(prisma, {
      actorUserId: user.id,
      actorRole: primaryRole,
      action: 'AUTH_REGISTER',
      resourceType: 'USER',
      resourceId: user.id,
      requestId: meta.requestId,
      ipAddress: meta.ipAddress,
      afterState: { email: user.email, primaryRole },
    });

    const accessToken = signAccessToken(user.id, user.email, sanitized.roles);
    return { user: sanitized, accessToken, refreshToken: rawRefreshToken };
  },

  async login(
    input: { email: string; password: string },
    meta: { requestId?: string; ipAddress?: string; userAgent?: string },
  ) {
    const user = await authRepository.findUserByEmail(input.email);
    if (!user) {
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const passwordMatches = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenError(`Account is ${user.status.toLowerCase()}`, 'ACCOUNT_INACTIVE');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const sanitized = sanitizeUser(user);
    const rawRefreshToken = crypto.randomBytes(48).toString('hex');
    const familyId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN, 7 * 86400_000));

    await authRepository.createRefreshToken({
      userId: user.id,
      tokenHash: sha256(rawRefreshToken),
      familyId,
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    await recordAuditLog(prisma, {
      actorUserId: user.id,
      actorRole: user.primaryRole,
      action: 'AUTH_LOGIN',
      resourceType: 'USER',
      resourceId: user.id,
      requestId: meta.requestId,
      ipAddress: meta.ipAddress,
    });

    const accessToken = signAccessToken(user.id, user.email, sanitized.roles);
    return { user: sanitized, accessToken, refreshToken: rawRefreshToken };
  },

  async refresh(
    rawRefreshToken: string,
    meta: { requestId?: string; ipAddress?: string; userAgent?: string },
  ) {
    if (!rawRefreshToken) {
      throw new UnauthorizedError('Refresh token is required', 'MISSING_REFRESH_TOKEN');
    }

    const tokenRecord = await authRepository.findRefreshTokenByHash(sha256(rawRefreshToken));
    if (!tokenRecord) {
      throw new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    }

    if (tokenRecord.revokedAt) {
      // Reuse detection: revoke entire token family
      await authRepository.revokeTokenFamily(tokenRecord.familyId);
      await recordAuditLog(prisma, {
        actorUserId: tokenRecord.userId,
        action: 'AUTH_REFRESH_REUSE_DETECTED',
        resourceType: 'REFRESH_TOKEN_FAMILY',
        resourceId: tokenRecord.familyId,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
      });
      throw new UnauthorizedError('Refresh token reuse detected; session revoked', 'REFRESH_TOKEN_REUSED');
    }

    if (tokenRecord.expiresAt < new Date()) {
      throw new UnauthorizedError('Refresh token expired', 'REFRESH_TOKEN_EXPIRED');
    }

    if (tokenRecord.user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenError('Account is inactive', 'ACCOUNT_INACTIVE');
    }

    const fullUser = await authRepository.findUserById(tokenRecord.userId);
    if (!fullUser) {
      throw new UnauthorizedError('User not found', 'USER_NOT_FOUND');
    }
    const sanitized = sanitizeUser(fullUser);

    const newRawRefreshToken = crypto.randomBytes(48).toString('hex');
    const newExpiresAt = new Date(Date.now() + parseDurationMs(env.JWT_REFRESH_EXPIRES_IN, 7 * 86400_000));

    await authRepository.rotateRefreshToken({
      oldTokenId: tokenRecord.id,
      userId: tokenRecord.userId,
      newTokenHash: sha256(newRawRefreshToken),
      familyId: tokenRecord.familyId,
      expiresAt: newExpiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const accessToken = signAccessToken(fullUser.id, fullUser.email, sanitized.roles);
    return { user: sanitized, accessToken, refreshToken: newRawRefreshToken };
  },

  async logout(userId: string, rawRefreshToken?: string, meta?: { requestId?: string; ipAddress?: string }) {
    if (rawRefreshToken) {
      const record = await authRepository.findRefreshTokenByHash(sha256(rawRefreshToken));
      if (record && record.userId === userId) {
        await authRepository.revokeTokenFamily(record.familyId);
      }
    } else {
      await authRepository.revokeAllUserRefreshTokens(userId);
    }

    await recordAuditLog(prisma, {
      actorUserId: userId,
      action: 'AUTH_LOGOUT',
      resourceType: 'USER',
      resourceId: userId,
      requestId: meta?.requestId,
      ipAddress: meta?.ipAddress,
    });
  },

  async requestPasswordReset(email: string, meta: { requestId?: string; ipAddress?: string }) {
    const user = await authRepository.findUserByEmail(email);
    if (!user) {
      // Do not reveal whether email exists
      return { requested: true };
    }
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await prisma.outboxEvent.create({
      data: {
        aggregateType: 'USER',
        aggregateId: user.id,
        eventType: 'PASSWORD_RESET_REQUESTED',
        payload: { email: user.email, expiresMinutes: 60 },
      },
    });
    await emailSandboxAdapter.sendEmail({
      to: user.email,
      subject: 'MarketSphere Password Reset Instructions',
      body: `Use password reset token: ${rawToken} (expires in 60 minutes).`,
      template: 'PASSWORD_RESET_REQUESTED',
      requestId: meta.requestId,
    });
    await recordAuditLog(prisma, {
      actorUserId: user.id,
      action: 'AUTH_PASSWORD_RESET_REQUESTED',
      resourceType: 'USER',
      resourceId: user.id,
      requestId: meta.requestId,
      ipAddress: meta.ipAddress,
    });
    return {
      requested: true,
    };
  },

  async confirmPasswordReset(token: string, newPassword: string, meta: { requestId?: string; ipAddress?: string }) {
    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(token) },
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new ValidationError('Invalid or expired password reset token', [], 'INVALID_RESET_TOKEN');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      });
      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });
      await tx.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await recordAuditLog(prisma, {
      actorUserId: record.userId,
      action: 'AUTH_PASSWORD_RESET_CONFIRMED',
      resourceType: 'USER',
      resourceId: record.userId,
      requestId: meta.requestId,
      ipAddress: meta.ipAddress,
    });
    return { reset: true };
  },

  async getCurrentUser(userId: string) {
    const user = await authRepository.findUserById(userId);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }
    return sanitizeUser(user);
  },
};
