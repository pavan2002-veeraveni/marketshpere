import crypto from 'crypto';
import {
  Prisma,
  RoleName,
  SellerOnboardingStatus,
  OnboardingVerificationStatus,
} from '@prisma/client';
import { prisma } from '../../common/prisma';
import { recordAuditLog } from '../../common/audit';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors';
import { buildPaginationMeta, getSkipTake } from '../../common/pagination';
import { validateAndPersistSandboxUpload } from '../../common/upload';
import { addMoney, money } from '../../common/decimal';

function slugifyStore(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) +
    '-' +
    crypto.randomBytes(2).toString('hex')
  );
}

export const sellersService = {
  async registerSeller(
    userId: string,
    input: {
      storeName: string;
      legalBusinessName: string;
      taxIdMasked: string;
      supportEmail: string;
      supportPhone: string;
      payoutAccountMasked?: string;
      returnPolicy?: string;
      bio?: string;
    },
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const existing = await prisma.seller.findUnique({ where: { userId } });
    if (existing) {
      throw new ConflictError('Seller profile already exists for this user', 'SELLER_ALREADY_EXISTS');
    }

    const seller = await prisma.$transaction(async (tx) => {
      const role = await tx.role.upsert({
        where: { name: RoleName.SELLER },
        update: {},
        create: { name: RoleName.SELLER, description: 'SELLER role' },
      });
      await tx.userRole.upsert({
        where: { userId_roleId: { userId, roleId: role.id } },
        update: {},
        create: { userId, roleId: role.id },
      });

      const created = await tx.seller.create({
        data: {
          userId,
          storeName: input.storeName,
          storeSlug: slugifyStore(input.storeName),
          onboardingStatus: SellerOnboardingStatus.DRAFT,
          profile: {
            create: {
              legalBusinessName: input.legalBusinessName,
              taxIdMasked: input.taxIdMasked,
              supportEmail: input.supportEmail,
              supportPhone: input.supportPhone,
              payoutAccountMasked: input.payoutAccountMasked,
              returnPolicy: input.returnPolicy,
              bio: input.bio,
            },
          },
        },
        include: { profile: true, onboardingRecords: true },
      });

      await recordAuditLog(tx, {
        actorUserId: userId,
        actorRole: RoleName.SELLER,
        action: 'SELLER_REGISTERED',
        resourceType: 'SELLER',
        resourceId: created.id,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
        afterState: { storeName: created.storeName, onboardingStatus: created.onboardingStatus },
      });
      return created;
    });

    return seller;
  },

  async getMySeller(userId: string) {
    const seller = await prisma.seller.findUnique({
      where: { userId },
      include: {
        profile: true,
        onboardingRecords: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!seller) throw new NotFoundError('Seller account not found');
    return seller;
  },

  async updateMySeller(
    userId: string,
    input: {
      storeName?: string;
      legalBusinessName?: string;
      supportEmail?: string;
      supportPhone?: string;
      payoutAccountMasked?: string;
      returnPolicy?: string;
      bio?: string;
    },
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const seller = await prisma.seller.findUnique({ where: { userId }, include: { profile: true } });
    if (!seller) throw new NotFoundError('Seller account not found');

    const updated = await prisma.$transaction(async (tx) => {
      const nextSeller = await tx.seller.update({
        where: { id: seller.id },
        data: {
          storeName: input.storeName,
        },
      });
      await tx.sellerProfile.upsert({
        where: { sellerId: seller.id },
        update: {
          legalBusinessName: input.legalBusinessName,
          supportEmail: input.supportEmail,
          supportPhone: input.supportPhone,
          payoutAccountMasked: input.payoutAccountMasked,
          returnPolicy: input.returnPolicy,
          bio: input.bio,
        },
        create: {
          sellerId: seller.id,
          legalBusinessName: input.legalBusinessName ?? seller.storeName,
          taxIdMasked: 'XX-XXX0000',
          supportEmail: input.supportEmail ?? 'support@seller.test',
          supportPhone: input.supportPhone ?? '+1-555-0000',
          payoutAccountMasked: input.payoutAccountMasked,
          returnPolicy: input.returnPolicy,
          bio: input.bio,
        },
      });
      await recordAuditLog(tx, {
        actorUserId: userId,
        actorRole: RoleName.SELLER,
        action: 'SELLER_PROFILE_UPDATED',
        resourceType: 'SELLER',
        resourceId: seller.id,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
        afterState: input,
      });
      return tx.seller.findUniqueOrThrow({
        where: { id: nextSeller.id },
        include: { profile: true, onboardingRecords: true },
      });
    });

    return updated;
  },

  async uploadOnboardingDocument(
    userId: string,
    file: Express.Multer.File | undefined,
    body: { step: string; documentType: string; submitForReview: boolean },
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const seller = await prisma.seller.findUnique({ where: { userId } });
    if (!seller) throw new NotFoundError('Seller profile not found');
    if (!file) throw new ValidationError('Onboarding document file is required');

    const stored = await validateAndPersistSandboxUpload(file, 'onboarding', [
      'application/pdf',
      'image/png',
      'image/jpeg',
    ]);

    return prisma.$transaction(async (tx) => {
      const doc = await tx.sellerOnboardingRecord.create({
        data: {
          sellerId: seller.id,
          step: body.step,
          documentType: body.documentType,
          originalName: stored.originalName,
          storageKey: stored.storageKey,
          mimeType: stored.mimeType,
          fileSizeBytes: stored.fileSizeBytes,
          checksumSha256: stored.checksumSha256,
          status: OnboardingVerificationStatus.PENDING,
        },
      });

      if (
        body.submitForReview &&
        (seller.onboardingStatus === SellerOnboardingStatus.DRAFT ||
          seller.onboardingStatus === SellerOnboardingStatus.REJECTED)
      ) {
        await tx.seller.update({
          where: { id: seller.id },
          data: { onboardingStatus: SellerOnboardingStatus.SUBMITTED, rejectionReason: null },
        });
      }

      await recordAuditLog(tx, {
        actorUserId: userId,
        actorRole: RoleName.SELLER,
        action: 'SELLER_DOCUMENT_UPLOADED',
        resourceType: 'SELLER_ONBOARDING_RECORD',
        resourceId: doc.id,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
        afterState: { documentType: doc.documentType, checksumSha256: doc.checksumSha256 },
      });

      return doc;
    });
  },

  async resubmitOnboarding(userId: string, meta: { requestId?: string; ipAddress?: string }) {
    const seller = await prisma.seller.findUnique({ where: { userId } });
    if (!seller) throw new NotFoundError('Seller not found');
    if (
      seller.onboardingStatus !== SellerOnboardingStatus.REJECTED &&
      seller.onboardingStatus !== SellerOnboardingStatus.DRAFT
    ) {
      throw new ValidationError(`Cannot resubmit onboarding from status ${seller.onboardingStatus}`);
    }

    const updated = await prisma.seller.update({
      where: { id: seller.id },
      data: { onboardingStatus: SellerOnboardingStatus.SUBMITTED, rejectionReason: null },
    });

    await recordAuditLog(prisma, {
      actorUserId: userId,
      actorRole: RoleName.SELLER,
      action: 'SELLER_ONBOARDING_RESUBMITTED',
      resourceType: 'SELLER',
      resourceId: seller.id,
      requestId: meta.requestId,
      ipAddress: meta.ipAddress,
    });
    return updated;
  },

  async getMyAnalytics(userId: string) {
    const seller = await prisma.seller.findUnique({ where: { userId } });
    if (!seller) throw new NotFoundError('Seller not found');

    const [productsCount, orderItems, commissionLedgers, settlements, returnsCount] = await Promise.all([
      prisma.product.count({ where: { sellerId: seller.id, deletedAt: null } }),
      prisma.orderItem.findMany({
        where: { sellerId: seller.id, order: { status: { not: 'CANCELLED' } } },
        select: { lineTotal: true, quantity: true, orderId: true, productTitleSnapshot: true },
      }),
      prisma.commissionLedger.findMany({
        where: { sellerId: seller.id },
        select: { grossAmount: true, commissionAmount: true, netSellerAmount: true, status: true },
      }),
      prisma.settlement.findMany({
        where: { sellerId: seller.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.returnRequest.count({ where: { sellerId: seller.id } }),
    ]);

    const grossSales = addMoney(...orderItems.map((i) => i.lineTotal.toString()));
    const totalCommission = addMoney(...commissionLedgers.map((c) => c.commissionAmount.toString()));
    const netEarnings = addMoney(...commissionLedgers.map((c) => c.netSellerAmount.toString()));
    const distinctOrders = new Set(orderItems.map((i) => i.orderId)).size;

    const topProductMap = new Map<string, { title: string; units: number; revenue: ReturnType<typeof money> }>();
    for (const item of orderItems) {
      const prev = topProductMap.get(item.productTitleSnapshot) ?? {
        title: item.productTitleSnapshot,
        units: 0,
        revenue: money('0'),
      };
      prev.units += item.quantity;
      prev.revenue = prev.revenue.plus(money(item.lineTotal.toString()));
      topProductMap.set(item.productTitleSnapshot, prev);
    }

    return {
      sellerId: seller.id,
      storeName: seller.storeName,
      onboardingStatus: seller.onboardingStatus,
      productsCount,
      ordersCount: distinctOrders,
      unitsSold: orderItems.reduce((acc, i) => acc + i.quantity, 0),
      returnsCount,
      grossSales: grossSales.toFixed(2),
      totalCommission: totalCommission.toFixed(2),
      netEarnings: netEarnings.toFixed(2),
      topProducts: Array.from(topProductMap.values())
        .sort((a, b) => b.units - a.units)
        .slice(0, 5)
        .map((p) => ({ title: p.title, units: p.units, revenue: p.revenue.toFixed(2) })),
      recentSettlements: settlements,
    };
  },

  async listSellers(query: { page: number; limit: number; status?: SellerOnboardingStatus; search?: string }) {
    const where: Prisma.SellerWhereInput = {};
    if (query.status) where.onboardingStatus = query.status;
    if (query.search) {
      where.OR = [
        { storeName: { contains: query.search, mode: 'insensitive' } },
        { user: { email: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const { skip, take } = getSkipTake(query.page, query.limit);
    const [items, total] = await Promise.all([
      prisma.seller.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true, status: true } },
          profile: true,
          onboardingRecords: true,
          _count: { select: { products: true, orderItems: true } },
        },
      }),
      prisma.seller.count({ where }),
    ]);

    return { items, meta: buildPaginationMeta(query.page, query.limit, total) };
  },

  async updateSellerStatus(
    sellerId: string,
    input: { status: SellerOnboardingStatus; reason?: string; commissionRateOverride?: string | null },
    adminUserId: string,
    meta: { requestId?: string; ipAddress?: string },
  ) {
    const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
    if (!seller) throw new NotFoundError('Seller not found');

    if (input.status === SellerOnboardingStatus.REJECTED && !input.reason) {
      throw new ValidationError('Rejection reason is required');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.seller.update({
        where: { id: sellerId },
        data: {
          onboardingStatus: input.status,
          rejectionReason: input.status === SellerOnboardingStatus.REJECTED ? input.reason : null,
          approvedAt: input.status === SellerOnboardingStatus.APPROVED ? new Date() : seller.approvedAt,
          suspendedAt: input.status === SellerOnboardingStatus.SUSPENDED ? new Date() : null,
          commissionRateOverride:
            input.commissionRateOverride !== undefined ? input.commissionRateOverride : seller.commissionRateOverride,
        },
      });

      if (input.status === SellerOnboardingStatus.APPROVED) {
        await tx.sellerOnboardingRecord.updateMany({
          where: { sellerId, status: OnboardingVerificationStatus.PENDING },
          data: {
            status: OnboardingVerificationStatus.VERIFIED,
            reviewerId: adminUserId,
            reviewedAt: new Date(),
            reviewerNotes: input.reason ?? 'Approved by marketplace admin',
          },
        });
      }

      await tx.notification.create({
        data: {
          userId: seller.userId,
          type: 'SELLER_STATUS_CHANGED',
          title: `Seller store status updated to ${input.status}`,
          message: input.reason ?? `Your store ${seller.storeName} is now ${input.status}.`,
        },
      });

      await recordAuditLog(tx, {
        actorUserId: adminUserId,
        actorRole: RoleName.ADMIN,
        action: 'SELLER_STATUS_UPDATED',
        resourceType: 'SELLER',
        resourceId: sellerId,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
        beforeState: { onboardingStatus: seller.onboardingStatus },
        afterState: { onboardingStatus: next.onboardingStatus, reason: input.reason },
      });

      return next;
    });

    return updated;
  },
};

export function assertSellerOwnership(resourceSellerId: string, callerSellerId?: string | null, roles: RoleName[] = []) {
  if (roles.includes(RoleName.ADMIN)) return;
  if (!callerSellerId || resourceSellerId !== callerSellerId) {
    throw new ForbiddenError('You are not authorized to access another seller resource', 'SELLER_ISOLATION_VIOLATION');
  }
}
