import { RoleName, SellerOnboardingStatus, UserStatus } from '@prisma/client';
import { prisma } from '../../common/prisma';

export const authRepository = {
  findUserByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
        seller: { select: { id: true, onboardingStatus: true, storeName: true, storeSlug: true } },
      },
    });
  },

  findUserById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
        seller: { select: { id: true, onboardingStatus: true, storeName: true, storeSlug: true } },
      },
    });
  },

  async createUserAccount(params: {
    email: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
    phone?: string;
    primaryRole: RoleName;
    storeName?: string;
    storeSlug?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const role = await tx.role.upsert({
        where: { name: params.primaryRole },
        update: {},
        create: { name: params.primaryRole, description: `${params.primaryRole} role` },
      });

      const user = await tx.user.create({
        data: {
          email: params.email,
          passwordHash: params.passwordHash,
          firstName: params.firstName,
          lastName: params.lastName,
          phone: params.phone,
          primaryRole: params.primaryRole,
          status: UserStatus.ACTIVE,
          userRoles: {
            create: { roleId: role.id },
          },
        },
      });

      let seller = null;
      if (params.primaryRole === RoleName.SELLER && params.storeName && params.storeSlug) {
        seller = await tx.seller.create({
          data: {
            userId: user.id,
            storeName: params.storeName,
            storeSlug: params.storeSlug,
            onboardingStatus: SellerOnboardingStatus.DRAFT,
          },
        });
      }

      return { user, seller };
    });
  },

  createRefreshToken(data: {
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return prisma.refreshToken.create({ data });
  },

  findRefreshTokenByHash(tokenHash: string) {
    return prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  },

  revokeTokenFamily(familyId: string) {
    return prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  revokeAllUserRefreshTokens(userId: string) {
    return prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async rotateRefreshToken(params: {
    oldTokenId: string;
    userId: string;
    newTokenHash: string;
    familyId: string;
    expiresAt: Date;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const nextToken = await tx.refreshToken.create({
        data: {
          userId: params.userId,
          tokenHash: params.newTokenHash,
          familyId: params.familyId,
          expiresAt: params.expiresAt,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        },
      });
      await tx.refreshToken.update({
        where: { id: params.oldTokenId },
        data: {
          revokedAt: new Date(),
          replacedByTokenId: nextToken.id,
        },
      });
      return nextToken;
    });
  },
};
