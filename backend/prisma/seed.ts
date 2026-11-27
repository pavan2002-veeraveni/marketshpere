import 'dotenv/config';
import bcrypt from 'bcryptjs';
import {
  PrismaClient,
  RoleName,
  UserStatus,
  SellerOnboardingStatus,
  OnboardingVerificationStatus,
  ProductStatus,
  InventoryMovementType,
  DiscountType,
  CommissionType,
  OrderStatus,
  OrderItemFulfillmentStatus,
  PaymentStatus,
  ShipmentStatus,
  CommissionLedgerStatus,
  SupportCaseStatus,
  SupportPriority,
  DisputeStatus,
  ReviewModerationStatus,
} from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS: Array<{ code: string; description: string }> = [
  { code: 'catalog:read', description: 'Read catalog and products' },
  { code: 'catalog:write', description: 'Create and update own products' },
  { code: 'catalog:moderate', description: 'Approve or reject marketplace products' },
  { code: 'inventory:read', description: 'View warehouse inventory' },
  { code: 'inventory:write', description: 'Adjust warehouse stock and fulfillments' },
  { code: 'cart:manage', description: 'Manage shopping cart and checkout' },
  { code: 'orders:read_own', description: 'View own orders' },
  { code: 'orders:read_seller', description: 'View orders containing seller items' },
  { code: 'orders:read_all', description: 'View all marketplace orders' },
  { code: 'orders:fulfill', description: 'Pick, pack, and ship allocated orders' },
  { code: 'orders:manage', description: 'Administer order transitions' },
  { code: 'sellers:onboard', description: 'Submit and update seller onboarding' },
  { code: 'sellers:approve', description: 'Approve, reject, or suspend sellers' },
  { code: 'returns:request', description: 'Request item returns' },
  { code: 'returns:review', description: 'Review returns and refunds' },
  { code: 'refunds:process', description: 'Initiate and reconcile refunds' },
  { code: 'commissions:read', description: 'View commission ledger and settlements' },
  { code: 'commissions:manage', description: 'Configure rules and approve settlements' },
  { code: 'support:manage', description: 'Handle support cases and disputes' },
  { code: 'admin:audit', description: 'View audit logs and system settings' },
];

const ROLE_PERMISSION_MAP: Record<RoleName, string[]> = {
  CUSTOMER: ['catalog:read', 'cart:manage', 'orders:read_own', 'returns:request'],
  SELLER: [
    'catalog:read',
    'catalog:write',
    'inventory:read',
    'inventory:write',
    'orders:read_seller',
    'orders:fulfill',
    'sellers:onboard',
    'returns:review',
    'commissions:read',
  ],
  WAREHOUSE_OPERATOR: ['catalog:read', 'inventory:read', 'inventory:write', 'orders:read_all', 'orders:fulfill'],
  SUPPORT_AGENT: ['catalog:read', 'orders:read_all', 'returns:review', 'refunds:process', 'support:manage'],
  ADMIN: PERMISSIONS.map((p) => p.code),
};

async function main() {
  console.log('Seeding MarketSphere PostgreSQL database...');
  const passwordHash = await bcrypt.hash('MarketSphere#2026', 10);

  // 1. Permissions & Roles
  const permissionRecords = new Map<string, string>();
  for (const perm of PERMISSIONS) {
    const record = await prisma.permission.upsert({
      where: { code: perm.code },
      update: { description: perm.description },
      create: perm,
    });
    permissionRecords.set(perm.code, record.id);
  }

  const roleRecords = new Map<RoleName, string>();
  for (const roleName of Object.values(RoleName)) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName, description: `${roleName} role` },
    });
    roleRecords.set(roleName, role.id);

    for (const permCode of ROLE_PERMISSION_MAP[roleName]) {
      const permId = permissionRecords.get(permCode)!;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permId } },
        update: {},
        create: { roleId: role.id, permissionId: permId },
      });
    }
  }

  // Helper to upsert users cleanly
  async function ensureUser(params: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    primaryRole: RoleName;
  }) {
    const user = await prisma.user.upsert({
      where: { email: params.email },
      update: {
        firstName: params.firstName,
        lastName: params.lastName,
        primaryRole: params.primaryRole,
        status: UserStatus.ACTIVE,
      },
      create: {
        email: params.email,
        passwordHash,
        firstName: params.firstName,
        lastName: params.lastName,
        phone: params.phone,
        primaryRole: params.primaryRole,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      },
    });
    const roleId = roleRecords.get(params.primaryRole)!;
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId } },
      update: {},
      create: { userId: user.id, roleId },
    });
    return user;
  }

  const adminUser = await ensureUser({
    email: 'admin@marketsphere.test',
    firstName: 'Elena',
    lastName: 'Vance',
    phone: '+1-555-0100',
    primaryRole: RoleName.ADMIN,
  });
  const supportUser = await ensureUser({
    email: 'support@marketsphere.test',
    firstName: 'Marcus',
    lastName: 'Chen',
    phone: '+1-555-0101',
    primaryRole: RoleName.SUPPORT_AGENT,
  });
  const warehouseUser = await ensureUser({
    email: 'warehouse@marketsphere.test',
    firstName: 'Devon',
    lastName: 'Brooks',
    phone: '+1-555-0102',
    primaryRole: RoleName.WAREHOUSE_OPERATOR,
  });
  const seller1User = await ensureUser({
    email: 'seller1@marketsphere.test',
    firstName: 'Sophia',
    lastName: 'Keller',
    phone: '+1-555-0103',
    primaryRole: RoleName.SELLER,
  });
  const seller2User = await ensureUser({
    email: 'seller2@marketsphere.test',
    firstName: 'Henrik',
    lastName: 'Solberg',
    phone: '+1-555-0104',
    primaryRole: RoleName.SELLER,
  });
  const sellerPendingUser = await ensureUser({
    email: 'seller3@marketsphere.test',
    firstName: 'Amara',
    lastName: 'Okafor',
    phone: '+1-555-0105',
    primaryRole: RoleName.SELLER,
  });
  const customerUser = await ensureUser({
    email: 'customer@marketsphere.test',
    firstName: 'Maya',
    lastName: 'Lin',
    phone: '+1-555-0106',
    primaryRole: RoleName.CUSTOMER,
  });
  const customer2User = await ensureUser({
    email: 'customer2@marketsphere.test',
    firstName: 'Liam',
    lastName: 'Patel',
    phone: '+1-555-0107',
    primaryRole: RoleName.CUSTOMER,
  });

  // Addresses
  const existingCustomerAddress = await prisma.address.findFirst({ where: { userId: customerUser.id } });
  const customerAddress =
    existingCustomerAddress ??
    (await prisma.address.create({
      data: {
        userId: customerUser.id,
        label: 'Home',
        recipientName: 'Maya Lin',
        line1: '742 Evergreen Terrace',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'US',
        phone: '+1-555-0106',
        isDefault: true,
      },
    }));

  // Sellers & Profiles
  const seller1 = await prisma.seller.upsert({
    where: { userId: seller1User.id },
    update: {},
    create: {
      userId: seller1User.id,
      storeName: 'Apex Electronics Studio',
      storeSlug: 'apex-electronics-studio',
      onboardingStatus: SellerOnboardingStatus.APPROVED,
      approvedAt: new Date(),
      profile: {
        create: {
          legalBusinessName: 'Apex Electronics LLC',
          taxIdMasked: 'XX-XXX4821',
          supportEmail: 'care@apexelectronics.test',
          supportPhone: '+1-555-0201',
          payoutAccountMasked: '**** 9942',
          returnPolicy: '30-day manufacturer defect & unopened returns accepted.',
          bio: 'Precision audio, studio peripherals, and connected hardware.',
        },
      },
    },
  });

  const seller2 = await prisma.seller.upsert({
    where: { userId: seller2User.id },
    update: {},
    create: {
      userId: seller2User.id,
      storeName: 'Nordic Home Living',
      storeSlug: 'nordic-home-living',
      onboardingStatus: SellerOnboardingStatus.APPROVED,
      commissionRateOverride: '0.1200',
      approvedAt: new Date(),
      profile: {
        create: {
          legalBusinessName: 'Nordic Home Goods Inc.',
          taxIdMasked: 'XX-XXX9104',
          supportEmail: 'hello@nordichome.test',
          supportPhone: '+1-555-0202',
          payoutAccountMasked: '**** 3318',
          returnPolicy: '14-day hassle-free returns in original packaging.',
          bio: 'Minimalist lighting, solid oak furniture, and ergonomic workspace gear.',
        },
      },
    },
  });

  const sellerPending = await prisma.seller.upsert({
    where: { userId: sellerPendingUser.id },
    update: {},
    create: {
      userId: sellerPendingUser.id,
      storeName: 'Artisan Coffee Roasters',
      storeSlug: 'artisan-coffee-roasters',
      onboardingStatus: SellerOnboardingStatus.SUBMITTED,
      profile: {
        create: {
          legalBusinessName: 'Artisan Roasters Co.',
          taxIdMasked: 'XX-XXX7719',
          supportEmail: 'support@artisanroast.test',
          supportPhone: '+1-555-0203',
          payoutAccountMasked: '**** 6120',
          bio: 'Specialty espresso hardware and small-batch accessories.',
        },
      },
    },
  });

  const onboardingCount = await prisma.sellerOnboardingRecord.count({ where: { sellerId: seller1.id } });
  if (onboardingCount === 0) {
    await prisma.sellerOnboardingRecord.createMany({
      data: [
        {
          sellerId: seller1.id,
          step: 'BUSINESS_VERIFICATION',
          documentType: 'EIN_CERTIFICATE',
          originalName: 'apex_ein_synthetic.pdf',
          storageKey: 'onboarding/apex/ein_synthetic.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 124512,
          checksumSha256: 'a'.repeat(64),
          status: OnboardingVerificationStatus.VERIFIED,
          reviewerId: adminUser.id,
          reviewerNotes: 'Synthetic verification approved.',
          reviewedAt: new Date(),
        },
        {
          sellerId: sellerPending.id,
          step: 'BUSINESS_VERIFICATION',
          documentType: 'BUSINESS_LICENSE',
          originalName: 'artisan_license_synthetic.pdf',
          storageKey: 'onboarding/artisan/license_synthetic.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 98210,
          checksumSha256: 'b'.repeat(64),
          status: OnboardingVerificationStatus.PENDING,
        },
      ],
    });
  }

  // Warehouses
  const whEast = await prisma.warehouse.upsert({
    where: { code: 'WH-EAST-01' },
    update: {},
    create: {
      code: 'WH-EAST-01',
      name: 'MarketSphere Newark Fulfillment Hub',
      addressLine1: '100 Port Logistics Blvd',
      city: 'Newark',
      state: 'NJ',
      postalCode: '07114',
      country: 'US',
    },
  });
  const whWest = await prisma.warehouse.upsert({
    where: { code: 'WH-WEST-01' },
    update: {},
    create: {
      code: 'WH-WEST-01',
      name: 'Apex Reno Regional Depot',
      sellerId: seller1.id,
      addressLine1: '450 Sierra Commerce Pkwy',
      city: 'Reno',
      state: 'NV',
      postalCode: '89506',
      country: 'US',
    },
  });

  // Categories
  const catElectronics = await prisma.category.upsert({
    where: { slug: 'electronics' },
    update: {},
    create: { name: 'Electronics', slug: 'electronics', description: 'Audio, compute & smart tech', sortOrder: 1 },
  });
  const catAudio = await prisma.category.upsert({
    where: { slug: 'audio-studio' },
    update: {},
    create: { name: 'Audio & Studio', slug: 'audio-studio', parentId: catElectronics.id, sortOrder: 2 },
  });
  const catHome = await prisma.category.upsert({
    where: { slug: 'home-office' },
    update: {},
    create: { name: 'Home & Office', slug: 'home-office', description: 'Workspace furniture & lighting', sortOrder: 3 },
  });
  const catAccessories = await prisma.category.upsert({
    where: { slug: 'accessories' },
    update: {},
    create: { name: 'Accessories', slug: 'accessories', description: 'Cables, stands, and everyday carry', sortOrder: 4 },
  });

  // Catalog Products + Variants + SKUs + Inventory
  const catalogSeed = [
    {
      sellerId: seller1.id,
      categoryId: catAudio.id,
      title: 'Apex Studio Pro ANC Headphones',
      slug: 'apex-studio-pro-anc-headphones',
      brand: 'Apex Audio',
      description: 'Reference wireless active noise-cancelling studio headphones with 45-hour battery and lossless USB-C audio.',
      imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800',
      attrs: [
        { name: 'Connectivity', value: 'Bluetooth 5.3 + USB-C' },
        { name: 'Battery', value: '45 Hours' },
      ],
      variants: [
        { name: 'Matte Black', optionValues: { color: 'Matte Black' }, skuCode: 'APX-HP-BLK', price: '249.00', compareAt: '299.00', qty: 45, warehouseId: whEast.id },
        { name: 'Silver Titanium', optionValues: { color: 'Silver Titanium' }, skuCode: 'APX-HP-SLV', price: '259.00', compareAt: '299.00', qty: 4, warehouseId: whWest.id },
      ],
    },
    {
      sellerId: seller1.id,
      categoryId: catElectronics.id,
      title: 'Apex KeyForge 75% Mechanical Keyboard',
      slug: 'apex-keyforge-75-mechanical-keyboard',
      brand: 'Apex Tech',
      description: 'CNC aluminum hot-swappable tactile mechanical keyboard with tri-mode wireless connectivity.',
      imageUrl: 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=800',
      attrs: [
        { name: 'Switches', value: 'Tactile Brown' },
        { name: 'Layout', value: '75% Compact' },
      ],
      variants: [
        { name: 'Graphite Tactile', optionValues: { color: 'Graphite', switch: 'Tactile' }, skuCode: 'APX-KB-GRP', price: '169.00', compareAt: '199.00', qty: 30, warehouseId: whEast.id },
      ],
    },
    {
      sellerId: seller1.id,
      categoryId: catAccessories.id,
      title: 'Apex ThunderDock 11-in-1 USB-C Hub',
      slug: 'apex-thunderdock-usb-c-hub',
      brand: 'Apex Tech',
      description: 'Dual 4K 60Hz HDMI, 100W PD pass-through, Gigabit Ethernet, and UHS-II SD card reader.',
      imageUrl: 'https://images.unsplash.com/photo-1625842268584-8f3296236761?w=800',
      attrs: [{ name: 'Power Delivery', value: '100W PD' }],
      variants: [
        { name: 'Space Gray', optionValues: { finish: 'Space Gray' }, skuCode: 'APX-HB-GRY', price: '89.00', compareAt: '109.00', qty: 60, warehouseId: whEast.id },
      ],
    },
    {
      sellerId: seller2.id,
      categoryId: catHome.id,
      title: 'Nordic Solis Architect Desk Lamp',
      slug: 'nordic-solis-architect-desk-lamp',
      brand: 'Nordic Living',
      description: 'High-CRI asymmetric LED task lamp in brushed aluminum with stepless dimming and warm-to-daylight presets.',
      imageUrl: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800',
      attrs: [
        { name: 'Color Rendering', value: 'CRI 96+' },
        { name: 'Material', value: 'Anodized Aluminum' },
      ],
      variants: [
        { name: 'Warm Sand', optionValues: { finish: 'Warm Sand' }, skuCode: 'NRD-LP-SND', price: '139.00', compareAt: '165.00', qty: 24, warehouseId: whEast.id },
        { name: 'Charcoal', optionValues: { finish: 'Charcoal' }, skuCode: 'NRD-LP-CHR', price: '139.00', compareAt: null, qty: 18, warehouseId: whEast.id },
      ],
    },
    {
      sellerId: seller2.id,
      categoryId: catHome.id,
      title: 'Fjord Ergonomic Oak Monitor Riser',
      slug: 'fjord-ergonomic-oak-monitor-riser',
      brand: 'Nordic Living',
      description: 'Solid European white oak dual-monitor shelf with felt storage tray and cable routing channel.',
      imageUrl: 'https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=800',
      attrs: [{ name: 'Width', value: '110 cm' }],
      variants: [
        { name: 'Natural Oak', optionValues: { wood: 'Natural Oak' }, skuCode: 'NRD-MR-OAK', price: '119.00', compareAt: '149.00', qty: 20, warehouseId: whEast.id },
      ],
    },
    {
      sellerId: seller2.id,
      categoryId: catAccessories.id,
      title: 'Vester Merino Felt Desk Mat',
      slug: 'vester-merino-felt-desk-mat',
      brand: 'Nordic Living',
      description: 'Extra-large 90x40cm natural wool desk mat with anti-slip cork backing.',
      imageUrl: 'https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=800',
      attrs: [{ name: 'Dimensions', value: '900 x 400 mm' }],
      variants: [
        { name: 'Heather Gray', optionValues: { color: 'Heather Gray' }, skuCode: 'NRD-DM-GRY', price: '49.00', compareAt: null, qty: 80, warehouseId: whEast.id },
      ],
    },
  ];

  const createdSkus: Array<{ id: string; skuCode: string; price: string; productId: string; sellerId: string; warehouseId: string }> = [];

  for (const item of catalogSeed) {
    const product = await prisma.product.upsert({
      where: { slug: item.slug },
      update: {},
      create: {
        sellerId: item.sellerId,
        categoryId: item.categoryId,
        title: item.title,
        slug: item.slug,
        brand: item.brand,
        description: item.description,
        status: ProductStatus.ACTIVE,
        images: {
          create: [{ url: item.imageUrl, altText: item.title, isPrimary: true, sortOrder: 0 }],
        },
        attributes: {
          create: item.attrs,
        },
      },
    });

    for (const v of item.variants) {
      const existingSku = await prisma.sku.findUnique({ where: { skuCode: v.skuCode } });
      if (!existingSku) {
        const variant = await prisma.productVariant.create({
          data: {
            productId: product.id,
            name: v.name,
            optionValues: v.optionValues,
          },
        });
        const sku = await prisma.sku.create({
          data: {
            productId: product.id,
            variantId: variant.id,
            skuCode: v.skuCode,
            price: v.price,
            compareAtPrice: v.compareAt,
            costPrice: (Number(v.price) * 0.55).toFixed(2),
            weightGrams: 650,
          },
        });
        const inv = await prisma.inventory.create({
          data: {
            skuId: sku.id,
            warehouseId: v.warehouseId,
            onHandQty: v.qty,
            reservedQty: 0,
            reorderPoint: 8,
          },
        });
        await prisma.inventoryLedger.create({
          data: {
            inventoryId: inv.id,
            skuId: sku.id,
            warehouseId: v.warehouseId,
            movementType: InventoryMovementType.ADJUSTMENT_IN,
            quantityDelta: v.qty,
            balanceAfter: v.qty,
            referenceType: 'SEED_INIT',
            referenceId: sku.skuCode,
            actorUserId: warehouseUser.id,
            notes: 'Initial synthetic seed stock',
          },
        });
        createdSkus.push({
          id: sku.id,
          skuCode: sku.skuCode,
          price: v.price,
          productId: product.id,
          sellerId: item.sellerId,
          warehouseId: v.warehouseId,
        });
      } else {
        const existingInv = await prisma.inventory.findFirst({
          where: { skuId: existingSku.id, warehouseId: v.warehouseId },
        });
        if (existingInv && existingInv.onHandQty < v.qty + existingInv.reservedQty) {
          await prisma.inventory.update({
            where: { id: existingInv.id },
            data: { onHandQty: v.qty + existingInv.reservedQty },
          });
        }
        createdSkus.push({
          id: existingSku.id,
          skuCode: existingSku.skuCode,
          price: existingSku.price.toString(),
          productId: existingSku.productId,
          sellerId: item.sellerId,
          warehouseId: v.warehouseId,
        });
      }
    }
  }

  // Discounts
  const now = new Date();
  const nextYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const lastMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  await prisma.discount.upsert({
    where: { code: 'WELCOME10' },
    update: {},
    create: {
      code: 'WELCOME10',
      discountType: DiscountType.PERCENTAGE,
      value: '10.00',
      minCartAmount: '50.00',
      maxDiscountAmount: '40.00',
      usageLimitTotal: 500,
      usageLimitPerCustomer: 3,
      startsAt: lastMonth,
      expiresAt: nextYear,
      isActive: true,
    },
  });
  await prisma.discount.upsert({
    where: { code: 'SAVE20' },
    update: {},
    create: {
      code: 'SAVE20',
      discountType: DiscountType.FIXED,
      value: '20.00',
      minCartAmount: '100.00',
      usageLimitTotal: 200,
      usageLimitPerCustomer: 2,
      startsAt: lastMonth,
      expiresAt: nextYear,
      isActive: true,
    },
  });
  await prisma.discount.upsert({
    where: { code: 'EXPIRED50' },
    update: {},
    create: {
      code: 'EXPIRED50',
      discountType: DiscountType.PERCENTAGE,
      value: '50.00',
      startsAt: lastMonth,
      expiresAt: yesterday,
      isActive: true,
    },
  });

  // Commission Rules
  const ruleCount = await prisma.commissionRule.count();
  let defaultRuleId: string;
  if (ruleCount === 0) {
    const globalRule = await prisma.commissionRule.create({
      data: {
        name: 'Global Marketplace Standard 10%',
        commissionType: CommissionType.PERCENTAGE,
        percentageRate: '0.1000',
        fixedAmount: '0.00',
        priority: 100,
      },
    });
    await prisma.commissionRule.create({
      data: {
        name: 'Audio & Studio Category 8%',
        categoryId: catAudio.id,
        commissionType: CommissionType.PERCENTAGE,
        percentageRate: '0.0800',
        fixedAmount: '0.00',
        priority: 20,
      },
    });
    defaultRuleId = globalRule.id;
  } else {
    const firstRule = await prisma.commissionRule.findFirstOrThrow();
    defaultRuleId = firstRule.id;
  }

  // Sample Delivered Order + Review + Commission + Support Case + Dispute
  const existingSampleOrder = await prisma.order.findUnique({ where: { orderNumber: 'MS-2026-10001' } });
  if (!existingSampleOrder && createdSkus.length >= 2) {
    const sku1 = createdSkus[0]!;
    const sku2 = createdSkus[3] ?? createdSkus[1]!;

    const sampleOrder = await prisma.order.create({
      data: {
        orderNumber: 'MS-2026-10001',
        customerId: customerUser.id,
        status: OrderStatus.DELIVERED,
        subtotalAmount: '388.00',
        discountAmount: '0.00',
        taxAmount: '32.01',
        shippingAmount: '0.00',
        totalAmount: '420.01',
        shippingAddressSnapshot: {
          recipientName: customerAddress.recipientName,
          line1: customerAddress.line1,
          city: customerAddress.city,
          state: customerAddress.state,
          postalCode: customerAddress.postalCode,
          country: customerAddress.country,
        },
        idempotencyKey: 'seed-order-ms-2026-10001',
        items: {
          create: [
            {
              sellerId: sku1.sellerId,
              productId: sku1.productId,
              skuId: sku1.id,
              warehouseId: sku1.warehouseId,
              productTitleSnapshot: 'Apex Studio Pro ANC Headphones',
              skuCodeSnapshot: sku1.skuCode,
              quantity: 1,
              unitPrice: sku1.price,
              lineTotal: sku1.price,
              fulfillmentStatus: OrderItemFulfillmentStatus.DELIVERED,
            },
            {
              sellerId: sku2.sellerId,
              productId: sku2.productId,
              skuId: sku2.id,
              warehouseId: sku2.warehouseId,
              productTitleSnapshot: 'Nordic Solis Architect Desk Lamp',
              skuCodeSnapshot: sku2.skuCode,
              quantity: 1,
              unitPrice: sku2.price,
              lineTotal: sku2.price,
              fulfillmentStatus: OrderItemFulfillmentStatus.DELIVERED,
            },
          ],
        },
        statusHistory: {
          create: [
            { fromStatus: null, toStatus: OrderStatus.PENDING_PAYMENT, reason: 'Order placed', changedByUserId: customerUser.id },
            { fromStatus: OrderStatus.PENDING_PAYMENT, toStatus: OrderStatus.PAYMENT_CONFIRMED, reason: 'Sandbox payment captured' },
            { fromStatus: OrderStatus.PAYMENT_CONFIRMED, toStatus: OrderStatus.DELIVERED, reason: 'Delivered by carrier', changedByUserId: warehouseUser.id },
          ],
        },
        payments: {
          create: {
            provider: 'SANDBOX_PAY',
            providerPaymentId: 'pay_sbx_10001',
            idempotencyKey: 'seed-pay-10001',
            amount: '420.01',
            status: PaymentStatus.CAPTURED,
            capturedAt: new Date(),
          },
        },
      },
      include: { items: true },
    });

    await prisma.shipment.create({
      data: {
        orderId: sampleOrder.id,
        sellerId: seller1.id,
        warehouseId: whEast.id,
        carrier: 'SANDBOX_EXPRESS',
        trackingNumber: 'SBX-TRK-9001001',
        status: ShipmentStatus.DELIVERED,
        shippedAt: yesterday,
        deliveredAt: now,
        events: {
          create: {
            providerEventId: 'shp_evt_seed_1',
            status: 'DELIVERED',
            location: 'Austin, TX',
            description: 'Package delivered to front door',
            rawPayload: { seeded: true },
          },
        },
      },
    });

    for (const oi of sampleOrder.items) {
      const gross = Number(oi.lineTotal);
      const commission = (gross * 0.1).toFixed(2);
      const net = (gross - Number(commission)).toFixed(2);
      await prisma.commissionLedger.create({
        data: {
          orderId: sampleOrder.id,
          orderItemId: oi.id,
          sellerId: oi.sellerId,
          commissionRuleId: defaultRuleId,
          grossAmount: oi.lineTotal,
          commissionAmount: commission,
          netSellerAmount: net,
          status: CommissionLedgerStatus.EARNED,
        },
      });
    }

    await prisma.review.create({
      data: {
        productId: sku1.productId,
        userId: customerUser.id,
        orderId: sampleOrder.id,
        rating: 5,
        title: 'Clean studio neutral sound',
        comment: 'Noise cancellation blocks office chatter cleanly and USB-C lossless mode works great.',
        isVerifiedPurchase: true,
        moderationStatus: ReviewModerationStatus.APPROVED,
      },
    });

    await prisma.supportCase.create({
      data: {
        caseNumber: 'CASE-2026-001',
        customerId: customerUser.id,
        orderId: sampleOrder.id,
        assignedAgentId: supportUser.id,
        subject: 'Requesting VAT/tax invoice copy for order MS-2026-10001',
        priority: SupportPriority.LOW,
        status: SupportCaseStatus.IN_PROGRESS,
        notes: {
          create: [
            {
              authorUserId: supportUser.id,
              isInternal: true,
              body: 'Verified order status is DELIVERED. Preparing PDF receipt metadata.',
            },
          ],
        },
      },
    });

    await prisma.dispute.create({
      data: {
        orderId: sampleOrder.id,
        customerId: customer2User.id,
        sellerId: seller2.id,
        assignedAgentId: supportUser.id,
        reason: 'Delayed transit inquiry on prior shipment',
        status: DisputeStatus.INVESTIGATING,
      },
    });
  }

  // System Config & Notifications
  await prisma.systemConfig.upsert({
    where: { key: 'marketplace.settings' },
    update: {},
    create: {
      key: 'marketplace.settings',
      value: {
        reservationTtlMinutes: 15,
        defaultTaxRate: 0.0825,
        defaultCommissionRate: 0.1,
        returnWindowDays: 30,
        sandboxPaymentsEnabled: true,
      },
      description: 'Core MarketSphere operational parameters',
      updatedByUserId: adminUser.id,
    },
  });

  const notifCount = await prisma.notification.count({ where: { userId: customerUser.id } });
  if (notifCount === 0) {
    await prisma.notification.create({
      data: {
        userId: customerUser.id,
        type: 'ORDER_DELIVERED',
        title: 'Order MS-2026-10001 delivered',
        message: 'Your order MS-2026-10001 has been delivered. Share a verified review!',
      },
    });
  }

  const existingCart = await prisma.cart.findUnique({ where: { userId: customerUser.id } });
  if (existingCart) {
    await prisma.cartItem.deleteMany({ where: { cartId: existingCart.id } });
  }

  console.log('Seed completed successfully.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
