import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { RoleName, SellerOnboardingStatus, UserStatus } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../prisma';
import { ForbiddenError, UnauthorizedError } from '../errors';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  roles: RoleName[];
  type: 'access';
}

async function resolveAuthenticatedUser(token: string) {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  if (!payload || payload.type !== 'access' || !payload.sub) {
    throw new UnauthorizedError('Invalid access token', 'INVALID_TOKEN');
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: {
      userRoles: {
        include: {
          role: {
            include: {
              rolePermissions: {
                include: { permission: true },
              },
            },
          },
        },
      },
      seller: {
        select: { id: true, onboardingStatus: true },
      },
    },
  });

  if (!user) {
    throw new UnauthorizedError('User account no longer exists', 'USER_NOT_FOUND');
  }
  if (user.status !== UserStatus.ACTIVE) {
    throw new ForbiddenError(`Account is ${user.status.toLowerCase()}`, 'ACCOUNT_INACTIVE');
  }

  const roles = user.userRoles.map((ur) => ur.role.name);
  if (!roles.includes(user.primaryRole)) {
    roles.push(user.primaryRole);
  }
  const permissions = Array.from(
    new Set(user.userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.code))),
  );

  return {
    userId: user.id,
    email: user.email,
    roles,
    permissions,
    sellerId: user.seller?.id ?? null,
    sellerStatus: user.seller?.onboardingStatus ?? null,
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header', 'MISSING_TOKEN');
    }
    const token = authHeader.slice(7).trim();
    req.user = await resolveAuthenticatedUser(token);
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      next(new UnauthorizedError('Access token expired', 'TOKEN_EXPIRED'));
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      next(new UnauthorizedError('Invalid access token', 'INVALID_TOKEN'));
      return;
    }
    next(err);
  }
}

export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.header('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      req.user = await resolveAuthenticatedUser(token);
    }
    next();
  } catch {
    next();
  }
}

export function requireRoles(...allowedRoles: RoleName[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }
    const hasRole = req.user.roles.some((r) => allowedRoles.includes(r));
    if (!hasRole) {
      next(new ForbiddenError('You do not have the required role for this action', 'INSUFFICIENT_ROLE'));
      return;
    }
    next();
  };
}

export function requirePermissions(...requiredPermissions: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }
    if (req.user.roles.includes(RoleName.ADMIN)) {
      next();
      return;
    }
    const hasAll = requiredPermissions.every((perm) => req.user!.permissions.includes(perm));
    if (!hasAll) {
      next(new ForbiddenError('Missing required permission', 'INSUFFICIENT_PERMISSION'));
      return;
    }
    next();
  };
}

export function requireApprovedSeller(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new UnauthorizedError('Authentication required'));
    return;
  }
  if (!req.user.roles.includes(RoleName.SELLER) && !req.user.roles.includes(RoleName.ADMIN)) {
    next(new ForbiddenError('Seller role required', 'SELLER_ROLE_REQUIRED'));
    return;
  }
  if (req.user.roles.includes(RoleName.ADMIN) && !req.user.sellerId) {
    next();
    return;
  }
  if (!req.user.sellerId) {
    next(new ForbiddenError('Seller profile not registered', 'SELLER_PROFILE_MISSING'));
    return;
  }
  if (req.user.sellerStatus !== SellerOnboardingStatus.APPROVED) {
    next(
      new ForbiddenError(
        `Seller account status is ${req.user.sellerStatus}; approval is required`,
        'SELLER_NOT_APPROVED',
      ),
    );
    return;
  }
  next();
}
