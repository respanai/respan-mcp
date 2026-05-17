import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient } from "../shared/client.js";

export function registerPromptTools(server: McpServer, client: AuthenticatedClient | null) {
  // 1. List all Prompts
  server.tool(
    "list_prompts",
    `List all prompts in your Respan organization.

Returns a paginated list of all prompts you have created in Respan.

RESPONSE FIELDS (per prompt):
- id: Unique prompt identifier (use this for other prompt operations)
- name: Prompt name/title
- description: Prompt description
- created_at: Creation timestamp
- updated_at: Last modification timestamp
- is_active: Whether the prompt is active
- version_count: Number of versions
- current_version: Currently active version number
- tags: Array of tags for organization

Prompts are reusable templates that can have multiple versions.
Use get_prompt_detail to see full prompt content, or list_prompt_versions to see all versions.`,
    {
      page_size: z
        .number()
        .optional()
        .describe("Number of prompts per page (1-50, default 25)"),
      page: z
        .number()
        .optional()
        .describe("Page number (default 1)"),
    },
    async ({ page_size = 25, page = 1 }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.listPrompts({
        Authorization: c.auth,
        page_size: Math.min(page_size, 50),
        page,
      });

      // Strip bloat from list response:
      // 1. current_version.messages can contain base64 image data (use get_prompt_detail instead)
      // 2. filters_data is backend filter metadata (~80KB) not useful for agents
      const cleaned = JSON.parse(JSON.stringify(data));
      delete cleaned.filters_data;
      const results = cleaned?.results ?? [];
      for (const prompt of results) {
        if (prompt?.current_version?.messages) {
          delete prompt.current_version.messages;
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(cleaned, null, 2) }],
      };
    }
  );

  // 2. Get single Prompt details
  server.tool(
    "get_prompt_detail",
    `Retrieve detailed information about a specific prompt.

Returns complete prompt data including:
- id: Unique prompt identifier
- name: Prompt name/title
- description: Prompt description
- messages: The prompt template messages (array of role/content objects)
- model: Default model for this prompt
- temperature: Default temperature setting
- max_tokens: Default max tokens setting
- created_at: Creation timestamp
- updated_at: Last modification timestamp
- is_active: Whether the prompt is active
- current_version: Currently active version
- version_count: Total number of versions
- tags: Array of tags
- metadata: Custom metadata object

The messages field contains the actual prompt template which may include:
- System messages with instructions
- User message templates with {{variables}}
- Assistant message examples

Use list_prompts first to find the prompt_id.`,
    {
      prompt_id: z.string().describe("Unique prompt identifier (from list_prompts)"),
    },
    async ({ prompt_id }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.retrievePrompt({ Authorization: c.auth, prompt_id });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 3. List versions of a specific Prompt
  server.tool(
    "list_prompt_versions",
    `List all versions of a specific prompt.

Returns all versions of a prompt, allowing you to track changes over time.

RESPONSE FIELDS (per version):
- id: Version identifier
- version: Version number (integer, starts at 1)
- prompt_id: Parent prompt identifier
- messages: The prompt template for this version
- model: Model setting for this version
- temperature: Temperature setting for this version
- max_tokens: Max tokens setting for this version
- created_at: When this version was created
- is_active: Whether this is the active/deployed version
- change_notes: Notes describing changes in this version
- created_by: User who created this version

Each prompt can have multiple versions. Typically one version is marked as active
and used in production, while others are archived or in development.

Use list_prompts first to find the prompt_id.`,
    {
      prompt_id: z.string().describe("Unique prompt identifier (from list_prompts)"),
    },
    async ({ prompt_id }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.listPromptVersions({ Authorization: c.auth, prompt_id });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 4. Get details of a specific Prompt version
  server.tool(
    "get_prompt_version_detail",
    `Retrieve detailed information about a specific version of a prompt.

Returns complete version data including:
- id: Version identifier
- version: Version number
- prompt_id: Parent prompt identifier
- messages: Full prompt template messages array
  - Each message has: role (system/user/assistant), content (template text)
  - Content may contain {{variable}} placeholders for dynamic values
- model: Model setting for this version
- temperature: Temperature setting (0.0-2.0)
- max_tokens: Maximum tokens for completion
- top_p: Top-p sampling parameter
- frequency_penalty: Frequency penalty (0.0-2.0)
- presence_penalty: Presence penalty (0.0-2.0)
- stop: Stop sequences array
- created_at: Creation timestamp
- updated_at: Last update timestamp
- is_active: Whether this version is active
- change_notes: Description of changes
- created_by: Creator information
- metadata: Custom metadata

Use list_prompts to find prompt_id, then list_prompt_versions to find the version number.`,
    {
      prompt_id: z.string().describe("Unique prompt identifier (from list_prompts)"),
      version: z
        .number()
        .describe(
          "Version number (integer, e.g. 1, 2, 3 — from the 'version' field in list_prompt_versions)"
        ),
    },
    async ({ prompt_id, version }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.retrievePromptVersion({
        Authorization: c.auth,
        prompt_id,
        version,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 5. Create a new Prompt
  server.tool(
    "create_prompt",
    "Create a new prompt template. Only sets name and description. Use create_prompt_version to add content.",
    {
      name: z.string().describe("Name for the new prompt template"),
      description: z
        .string()
        .optional()
        .describe("Optional description of the prompt's purpose"),
    },
    async ({ name, description }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.createPrompt({
        Authorization: c.auth,
        name,
        ...(description !== undefined ? { description } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 6. Update Prompt metadata
  server.tool(
    "update_prompt",
    "Update a prompt's name and/or description.",
    {
      prompt_id: z.string().describe("Unique prompt identifier (from list_prompts)"),
      name: z.string().optional().describe("New name for the prompt"),
      description: z
        .string()
        .optional()
        .describe("New description for the prompt"),
    },
    async ({ prompt_id, name, description }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.updatePrompt({
        Authorization: c.auth,
        prompt_id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 7. Create a new Prompt version
  server.tool(
    "create_prompt_version",
    "Create a new version of a prompt. The version is always created as NOT deployed.",
    {
      prompt_id: z.string().describe("Unique prompt identifier (from list_prompts)"),
      messages: z
        .array(
          z.object({
            role: z.string().describe("Message role (e.g. system, user, assistant)"),
            content: z
              .string()
              .describe(
                "Message content text, may include {{variable}} placeholders"
              ),
          })
        )
        .describe("Array of message objects defining the prompt template"),
      model: z
        .string()
        .describe("Model identifier to use for this version (e.g. gpt-4o) — required"),
      temperature: z
        .number()
        .optional()
        .describe("Sampling temperature (0.0-2.0)"),
      max_tokens: z
        .number()
        .optional()
        .describe("Maximum number of tokens for the completion"),
      top_p: z.number().optional().describe("Top-p (nucleus) sampling parameter"),
      frequency_penalty: z
        .number()
        .optional()
        .describe("Frequency penalty (0.0-2.0)"),
      presence_penalty: z
        .number()
        .optional()
        .describe("Presence penalty (0.0-2.0)"),
      stop: z
        .array(z.string().describe("A stop sequence string"))
        .optional()
        .describe("Array of stop sequences"),
    },
    async ({
      prompt_id,
      messages,
      model,
      temperature,
      max_tokens,
      top_p,
      frequency_penalty,
      presence_penalty,
      stop,
    }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.createPromptVersion({
        Authorization: c.auth,
        prompt_id,
        messages,
        model,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(max_tokens !== undefined ? { max_tokens } : {}),
        ...(top_p !== undefined ? { top_p } : {}),
        ...(frequency_penalty !== undefined ? { frequency_penalty } : {}),
        ...(presence_penalty !== undefined ? { presence_penalty } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 8. Update an existing Prompt version
  server.tool(
    "update_prompt_version",
    "Update an existing prompt version. Always keeps deploy: false.",
    {
      prompt_id: z.string().describe("Unique prompt identifier (from list_prompts)"),
      version: z
        .number()
        .describe(
          "Version number to update (integer, from list_prompt_versions)"
        ),
      messages: z
        .array(
          z.object({
            role: z.string().describe("Message role (e.g. system, user, assistant)"),
            content: z
              .string()
              .describe(
                "Message content text, may include {{variable}} placeholders"
              ),
          })
        )
        .optional()
        .describe("Updated array of message objects defining the prompt template"),
      model: z
        .string()
        .optional()
        .describe("Updated model identifier (e.g. gpt-4o)"),
      temperature: z
        .number()
        .optional()
        .describe("Updated sampling temperature (0.0-2.0)"),
      max_tokens: z
        .number()
        .optional()
        .describe("Updated maximum number of tokens for the completion"),
      top_p: z
        .number()
        .optional()
        .describe("Updated top-p (nucleus) sampling parameter"),
      frequency_penalty: z
        .number()
        .optional()
        .describe("Updated frequency penalty (0.0-2.0)"),
      presence_penalty: z
        .number()
        .optional()
        .describe("Updated presence penalty (0.0-2.0)"),
      stop: z
        .array(z.string().describe("A stop sequence string"))
        .optional()
        .describe("Updated array of stop sequences"),
    },
    async ({
      prompt_id,
      version,
      messages,
      model,
      temperature,
      max_tokens,
      top_p,
      frequency_penalty,
      presence_penalty,
      stop,
    }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.updatePromptVersion({
        Authorization: c.auth,
        prompt_id,
        version,
        deploy: false,
        ...(messages !== undefined ? { messages } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(max_tokens !== undefined ? { max_tokens } : {}),
        ...(top_p !== undefined ? { top_p } : {}),
        ...(frequency_penalty !== undefined ? { frequency_penalty } : {}),
        ...(presence_penalty !== undefined ? { presence_penalty } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "deploy_prompt_version",
    `Deploy a specific prompt version, making it the active version that experiments (and other workflows) will use.

Background: when you create a prompt version, it starts as a draft (not deployed). The platform requires at least one DEPLOYED version before a prompt can be referenced by version number in experiments or other workflows. If you call create_experiment with a prompt workflow and see "Prompt version X not found", you forgot to deploy.

Tip: in the UI it's common to have multiple versions (draft + deployed). To switch the active version, just deploy the new one — the previous deployed version stays in history.`,
    {
      prompt_id: z.string().describe("Unique prompt identifier (from list_prompts)"),
      version: z.number().describe("Version number to deploy as the active version"),
    },
    async ({ prompt_id, version }) => {
      const c = requireClient(client);
      const data = await c.client.prompts.updatePromptVersion({
        Authorization: c.auth,
        prompt_id,
        version,
        deploy: true,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
