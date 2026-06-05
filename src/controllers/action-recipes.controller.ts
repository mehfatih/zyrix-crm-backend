import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types";
import {
  listRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  executeRecipeConfig,
  validateRecipeConfig,
  type RecipeType,
} from "../services/action-recipes.service";

// ============================================================================
// CUSTOM ACTIONS CONTROLLER — /api/action-recipes/* (Sprint 13)
// ============================================================================

function auth(req: Request) {
  const r = req as AuthenticatedRequest;
  return { userId: r.user.userId, companyId: r.user.companyId };
}

const RECIPE_TYPES = ["webhook_out", "compute_field", "conditional_update"] as const;

const createSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(RECIPE_TYPES),
  config: z.record(z.any()),
  enabled: z.boolean().optional(),
});
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  config: z.record(z.any()).optional(),
  enabled: z.boolean().optional(),
});
const testSchema = z.object({
  // optional inline config (test before save) — falls back to the saved recipe
  type: z.enum(RECIPE_TYPES).optional(),
  config: z.record(z.any()).optional(),
  sample: z.record(z.any()).optional(),
});

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    res.json({ success: true, data: await listRecipes(companyId) });
  } catch (e) {
    next(e);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const r = await getRecipe(companyId, String(req.params.id));
    if (!r) return res.status(404).json({ success: false, error: { message: "Recipe not found" } });
    res.json({ success: true, data: r });
  } catch (e) {
    next(e);
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId, userId } = auth(req);
    const dto = createSchema.parse(req.body);
    const r = await createRecipe(companyId, userId, {
      name: dto.name,
      type: dto.type as RecipeType,
      config: dto.config,
      enabled: dto.enabled,
    });
    res.status(201).json({ success: true, data: r });
  } catch (e) {
    next(e);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = updateSchema.parse(req.body);
    const r = await updateRecipe(companyId, String(req.params.id), dto);
    res.json({ success: true, data: r });
  } catch (e) {
    next(e);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    await deleteRecipe(companyId, String(req.params.id));
    res.json({ success: true, data: { deleted: true } });
  } catch (e) {
    next(e);
  }
}

// Dry-run: resolve the recipe against a sample record WITHOUT side effects
// (webhook is validated for SSRF + the resolved payload/signature returned, but
// NOT sent). Works on an unsaved config (type+config in body) or a saved id.
export async function test(req: Request, res: Response, next: NextFunction) {
  try {
    const { companyId } = auth(req);
    const dto = testSchema.parse(req.body);

    let type: RecipeType;
    let config: any;
    if (dto.type && dto.config) {
      type = dto.type as RecipeType;
      config = dto.config;
      const v = validateRecipeConfig(type, config);
      if (!v.ok) return res.status(422).json({ success: false, error: { message: v.error } });
    } else {
      const r = await getRecipe(companyId, String(req.params.id));
      if (!r) return res.status(404).json({ success: false, error: { message: "Recipe not found" } });
      type = r.type as RecipeType;
      config = r.config;
    }

    // Default sample record — overridable by the caller.
    const sample = dto.sample ?? {
      event: { type: "test" },
      contact: {
        id: "sample-contact",
        fullName: "Test Contact",
        email: "test@example.com",
        phone: "+905551112233",
        companyName: "Acme",
        city: "Istanbul",
        country: "TR",
        status: "qualified",
        leadScore: 60,
        healthScore: 70,
        lifetimeValue: 1200,
      },
      deal: {
        id: "sample-deal",
        title: "Sample deal",
        value: 5000,
        currency: "USD",
        stage: "proposal",
        probability: 40,
      },
    };

    const result = await executeRecipeConfig(companyId, type, config, sample, { dryRun: true });
    res.json({ success: true, data: { dryRun: true, result } });
  } catch (e) {
    next(e);
  }
}
