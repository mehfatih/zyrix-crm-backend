import type { Request, Response } from "express";

// ============================================================================
// OPENAPI 3.0 SPEC FOR PUBLIC API v1
// ----------------------------------------------------------------------------
// Returned from GET /v1/openapi.json — third-party tools (Postman, Stoplight,
// code generators) can consume this to auto-build clients. Zapier doesn't
// need this directly (we build their Zap templates manually) but it's good
// hygiene to publish.
// ============================================================================

const SPEC = {
  openapi: "3.0.3",
  info: {
    title: "Zyrix CRM Public API",
    version: "1.0.0",
    description:
      "Programmatic access to Zyrix CRM customers, deals, and activities. Authenticate with an API key created in Settings → API keys.",
    contact: {
      name: "Zyrix support",
      url: "https://zyrix.co",
    },
  },
  servers: [
    { url: "https://api.crm.zyrix.co/v1", description: "Production" },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "zy_live_...",
      },
    },
    schemas: {
      Customer: {
        type: "object",
        required: ["id", "fullName", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          fullName: { type: "string" },
          email: { type: "string", format: "email", nullable: true },
          phone: { type: "string", nullable: true },
          whatsappPhone: { type: "string", nullable: true },
          companyName: { type: "string", nullable: true },
          position: { type: "string", nullable: true },
          country: { type: "string", nullable: true },
          city: { type: "string", nullable: true },
          address: { type: "string", nullable: true },
          status: { type: "string", example: "new" },
          source: { type: "string", nullable: true },
          notes: { type: "string", nullable: true },
          lifetimeValue: { type: "number" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Deal: {
        type: "object",
        required: ["id", "title", "customerId", "stage", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: "string" },
          customerId: { type: "string", format: "uuid" },
          customer: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              fullName: { type: "string" },
              companyName: { type: "string", nullable: true },
            },
            nullable: true,
          },
          value: { type: "number" },
          currency: { type: "string", example: "USD" },
          stage: {
            type: "string",
            enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
          },
          probability: { type: "integer", minimum: 0, maximum: 100 },
          expectedCloseDate: { type: "string", format: "date-time", nullable: true },
          actualCloseDate: { type: "string", format: "date-time", nullable: true },
          description: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Activity: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          type: {
            type: "string",
            enum: ["note", "call", "email", "meeting", "task", "whatsapp"],
          },
          title: { type: "string" },
          content: { type: "string", nullable: true },
          customerId: { type: "string", format: "uuid", nullable: true },
          dealId: { type: "string", format: "uuid", nullable: true },
          dueDate: { type: "string", format: "date-time", nullable: true },
          completedAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Pagination: {
        type: "object",
        properties: {
          page: { type: "integer" },
          limit: { type: "integer" },
          total: { type: "integer" },
          totalPages: { type: "integer" },
        },
      },
      Error: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    "/auth/test": {
      get: {
        summary: "Verify API key",
        description: "Returns 200 with the authenticated company id if the key is valid.",
        tags: ["Auth"],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        authenticated: { type: "boolean" },
                        companyId: { type: "string", format: "uuid" },
                        apiVersion: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/customers": {
      get: {
        summary: "List customers",
        tags: ["Customers"],
        parameters: [
          { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
          { in: "query", name: "limit", schema: { type: "integer", maximum: 100 } },
          { in: "query", name: "search", schema: { type: "string" } },
          { in: "query", name: "status", schema: { type: "string" } },
          {
            in: "query",
            name: "since",
            schema: { type: "string", format: "date-time" },
            description: "Only return customers created after this timestamp (useful for polling)",
          },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Customer" } },
                    pagination: { $ref: "#/components/schemas/Pagination" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        summary: "Create a customer",
        tags: ["Customers"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["fullName"],
                properties: {
                  fullName: { type: "string" },
                  email: { type: "string", format: "email" },
                  phone: { type: "string" },
                  whatsappPhone: { type: "string" },
                  companyName: { type: "string" },
                  position: { type: "string" },
                  country: { type: "string" },
                  city: { type: "string" },
                  source: { type: "string" },
                  status: { type: "string" },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { $ref: "#/components/schemas/Customer" } },
                },
              },
            },
          },
        },
      },
    },
    "/customers/{id}": {
      get: {
        summary: "Get one customer",
        tags: ["Customers"],
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
      },
      patch: {
        summary: "Update a customer",
        tags: ["Customers"],
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      },
      delete: {
        summary: "Delete a customer",
        tags: ["Customers"],
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      },
    },
    "/deals": {
      get: {
        summary: "List deals",
        tags: ["Deals"],
        parameters: [
          { in: "query", name: "page", schema: { type: "integer" } },
          { in: "query", name: "limit", schema: { type: "integer" } },
          { in: "query", name: "stage", schema: { type: "string" } },
          { in: "query", name: "customerId", schema: { type: "string" } },
          { in: "query", name: "since", schema: { type: "string", format: "date-time" } },
        ],
      },
      post: { summary: "Create a deal", tags: ["Deals"] },
    },
    "/deals/{id}": {
      get: { summary: "Get one deal", tags: ["Deals"] },
      patch: { summary: "Update a deal", tags: ["Deals"] },
    },
    "/activities": {
      post: { summary: "Create an activity (note, call, email, meeting, task)", tags: ["Activities"] },
    },
  },
};

export function getOpenApiSpec(_req: Request, res: Response) {
  res.status(200).json(SPEC);
}
