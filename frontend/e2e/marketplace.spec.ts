import path from 'path';
import fs from 'fs';
import { test, expect } from '@playwright/test';

const screenshotsDir = path.resolve(__dirname, '../../docs/assessments/screenshots');

test.describe('MarketSphere Full-Stack End-to-End Flow', () => {
  test.beforeAll(() => {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  });

  test('customer discovers product, adds to cart, checks out with sandbox payment, and views portals', async ({ page }) => {
    // 1. Storefront discovery & search
    await page.goto('/');
    await expect(page.getByText('Discover Verified Sellers & Precision Gear')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Product catalog' }).getByRole('link').first()).toBeVisible();
    await page.screenshot({ path: path.join(screenshotsDir, '01-storefront.png'), fullPage: true });

    // 2. Sign in as Customer via quick-fill
    await page.goto('/login');
    await page.getByText('Customer (Maya Lin)').click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15000 });

    // 3. Search catalog, view Product detail & Add to Cart
    await page.getByRole('searchbox', { name: 'Search catalog' }).fill('Apex Studio');
    await page.getByRole('button', { name: 'Search Catalog' }).click();
    await page.getByText('Apex Studio Pro ANC Headphones').first().click();
    await expect(page.getByText('Select Variant / SKU')).toBeVisible();
    await page.screenshot({ path: path.join(screenshotsDir, '02-product-detail.png'), fullPage: true });
    await page.getByRole('button', { name: /Add to Cart/i }).click();
    await expect(page.getByText('Added to cart!')).toBeVisible();

    // 4. Cart & Checkout
    await page.goto('/cart');
    await expect(page.getByText('Order Summary')).toBeVisible();
    await page.screenshot({ path: path.join(screenshotsDir, '03-cart.png'), fullPage: true });
    await page.getByRole('button', { name: /Proceed to Checkout/i }).click();

    await expect(page).toHaveURL(/\/checkout/, { timeout: 15000 });
    await page.getByRole('button', { name: /Reserve Stock & Place Order/i }).click();
    await expect(page.getByText('Sandbox Payment Gateway')).toBeVisible();
    await page.getByRole('button', { name: /Simulate Payment Success/i }).click();
    await expect(page.getByText('PAYMENT CONFIRMED').first()).toBeVisible();
    await page.screenshot({ path: path.join(screenshotsDir, '04-payment-confirmed.png'), fullPage: true });
    await page.getByRole('button', { name: /Track Order Details/i }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+/i, { timeout: 15000 });
    await expect(page.getByText('Lifecycle Timeline')).toBeVisible();
    await expect(page.getByText('Financial Breakdown')).toBeVisible();

    // 5. Sign out & check Seller Portal
    await page.getByRole('button', { name: /Sign out/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    await page.getByText('Seller (Apex Studio)').click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/seller/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Apex Electronics Studio' })).toBeVisible();
    await expect(page.getByText('Gross Sales')).toBeVisible();
    await page.screenshot({ path: path.join(screenshotsDir, '05-seller-portal.png'), fullPage: true });
    await page.getByRole('button', { name: /Products & Feed Import/i }).click();
    await expect(page.getByText(/Bulk CSV Feed Import/i)).toBeVisible();

    // 6. Sign out & check Warehouse Portal (view queue + perform live stock adjustment)
    await page.getByRole('button', { name: /Sign out/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    await page.getByText('Warehouse Operator').click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/warehouse/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Warehouse Fulfillment & Stock Control' })).toBeVisible();
    await expect(page.getByText('Allocated Orders Queue')).toBeVisible();
    await page.screenshot({ path: path.join(screenshotsDir, '06-warehouse-portal.png'), fullPage: true });
    await page.getByRole('button', { name: /Inventory & Adjustments/i }).click();
    await page.locator('select').first().selectOption({ index: 1 });
    await page.getByRole('button', { name: /Commit Movement/i }).click();
    await expect(page.getByText('Warehouse stock updated')).toBeVisible();

    // 7. Sign out & check Support Portal (verify queue + persist internal note mutation)
    await page.getByRole('button', { name: /Sign out/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    await page.getByText('Support Agent').click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/support/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Customer Support, Returns & Disputes Desk' })).toBeVisible();
    await expect(page.getByText('CASE-2026-001')).toBeVisible();
    await page.getByPlaceholder('Add internal agent note...').first().fill('E2E agent verification note');
    await page.getByRole('button', { name: 'Add Note' }).first().click();
    await expect(page.getByText('Internal note added')).toBeVisible();
    await page.screenshot({ path: path.join(screenshotsDir, '07-support-portal.png'), fullPage: true });

    // 8. Sign out & check Admin Dashboard (charts + governance trigger)
    await page.getByRole('button', { name: /Sign out/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
    await page.getByText('Marketplace Admin').click();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/admin/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Marketplace Administration Console' })).toBeVisible();
    await expect(page.getByText('Marketplace GMV')).toBeVisible();
    await expect(page.getByText('Order Distribution by Status')).toBeVisible();
    await page.screenshot({ path: path.join(screenshotsDir, '08-admin-console.png'), fullPage: true });

    // 9. Verify Admin Governance Tab & live Worker Job Trigger
    await page.getByRole('button', { name: /Audit Logs & Jobs/i }).click();
    await expect(page.getByText('Manual Worker & Maintenance Triggers')).toBeVisible();
    await page.getByRole('button', { name: /Run Outbox Dispatch/i }).click();
    await expect(page.getByText('Executed outbox-dispatch')).toBeVisible();

    // 10. Verify silent cookie refresh reload persistence, Forgot Password, and Mobile/Tablet viewports
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Marketplace Administration Console' })).toBeVisible();
    await page.goto('/forgot-password');
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    for (const vp of [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Discover Verified Sellers & Precision Gear' })).toBeVisible();
      const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      expect(hasOverflow).toBe(false);
    }
  });
});
