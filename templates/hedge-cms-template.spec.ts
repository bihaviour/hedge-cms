import { expect, test } from "./fixtures";

/**
 * Smoke test for `hedge-cms-template`, written against the fixtures in `cloudflare/templates`.
 *
 * Formatted in *their* house style — tabs, double quotes, semicolons — and excluded from Biome in
 * `biome.json` for that reason. This file is not part of the Hedge build: it lives here so it can be
 * reviewed and kept in step with the admin it drives, and it runs only inside their repository,
 * where `prettier . --check` is what it has to satisfy.
 *
 * Copy this file to `playwright-tests/hedge-cms-template.spec.ts` in a checkout of that repository —
 * the filename is load-bearing. `fixtures.ts` derives the template name from it
 * (`testInfo.file.replace(".spec.ts", "")`) and looks that directory up, so a differently-named file
 * fails with "template not found" rather than testing the wrong thing.
 *
 * The harness starts the server itself: it copies `.dev.vars.example` to `.dev.vars`, spawns
 * `npm run dev` in the template directory, and polls `cloudflare.healthCheckPath` (`/api/health`)
 * for 30 seconds. That budget has to cover `d1 migrations apply --local` and a Vite build of the
 * admin app on a cold checkout. `/api/health` is the one route that answers without touching auth,
 * so readiness means the Worker is up rather than only the asset router.
 *
 * **Every test takes `templateUrl` and navigates through it.** Their `playwright.config.ts` sets no
 * `baseURL`, so `page.goto("/")` fails with "Cannot navigate to invalid URL" — and `templateUrl` is
 * also the fixture that *starts the server*, so a test that omits it only passes when an earlier one
 * in the file happened to boot it. Both were found by running their harness (#52), not by reading it.
 *
 * Kept to critical paths, per CONTRIBUTING. Collections, media, entry workflow and MCP are covered
 * by the upstream repository's own suite, which is a poor use of somebody else's CI.
 *
 * **Nothing here signs in with a password, and that is deliberate.** A correct password from a
 * browser the account has never been seen on does not produce a session in Hedge — it produces a
 * six-digit code mailed to the address on the account, which in development is printed to the
 * server log rather than sent. Every Playwright browser is an unrecognised device, so a sign-in test
 * would hang on a code it cannot read. The wizard is exempt because it creates the session itself.
 */

test("health endpoint answers", async ({ page, templateUrl }) => {
	// The cheapest possible signal, and the one that tells "the Worker is down" apart from "the UI
	// changed" when this fails on their CI six months from now.
	const response = await page.request.get(`${templateUrl}/api/health`);
	expect(response.status()).toBe(200);
	expect(await response.json()).toMatchObject({ status: "ok" });
});

test("first run lands on the setup wizard", async ({ page, templateUrl }) => {
	await page.goto(templateUrl);
	// A fresh D1 has no owner, so every path routes to the wizard until one exists. Reaching it
	// proves the Worker, the assets binding, D1 and the SPA router are all live at once.
	await expect(page).toHaveURL(/\/onboarding$/);
	await expect(page.getByText("Set up Hedge")).toBeVisible();
});

test("creating the first owner advances to the site step", async ({
	page,
	templateUrl,
}) => {
	await page.goto(`${templateUrl}/onboarding`);

	await page.getByLabel("Your name").fill("Template Owner");
	await page.getByLabel("Email").fill("owner@example.com");
	// `exact` matters: the show/hide control beside the field is labelled "Show password", so a
	// loose match resolves to two elements and fails on strict mode rather than on the CMS.
	// The form requires at least 12 characters.
	await page
		.getByLabel("Password", { exact: true })
		.fill("hedge-template-owner");
	await page.getByRole("button", { name: "Create account" }).click();

	// Step one creates the account and signs the owner in; the wizard then asks for the first site,
	// which is the tenant every piece of content hangs off. Getting here means the account was
	// written to D1 and the session cookie came back and was accepted.
	await expect(page.getByText("Create your first site")).toBeVisible({
		timeout: 15_000,
	});
});
