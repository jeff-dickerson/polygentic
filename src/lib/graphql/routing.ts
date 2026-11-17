/**
 * GraphQL slice for model routing: `agentRouting` feeds the Plan Mode stage
 * chips, `availableModels` feeds the Home model selector. Merge `typeDefs`
 * and `resolvers` into the executable schema.
 */

import { availableModels, type ModelSpec } from "../agents/models.ts";
import { agentRouting, overridesFromEnv, resolveRouting } from "../agents/routing.ts";

export const typeDefs = /* GraphQL */ `
  enum ModelTier {
    air
    standard
    max
  }

  enum PipelineStage {
    classifier
    planner
    editor
    verifier
  }

  type ModelCapabilities {
    reasoning: Boolean!
    toolUse: Boolean!
    jsonMode: Boolean!
  }

  type Model {
    id: ID!
    label: String!
    tier: ModelTier!
    contextWindow: Int!
    creditsPerAction: Int!
    capabilities: ModelCapabilities!
  }

  type AgentRoute {
    stage: PipelineStage!
    label: String!
    model: ID
    modelLabel: String
    tier: ModelTier
    reasoning: Boolean!
    creditsPerAction: Int!
    fallbacks: [ID!]!
    usesModel: Boolean!
    deterministicFallback: String
  }

  extend type Query {
    agentRouting: [AgentRoute!]!
    availableModels: [Model!]!
  }
`;

export const resolvers = {
  Query: {
    agentRouting: () => agentRouting(resolveRouting({ overrides: overridesFromEnv(process.env) })),
    availableModels: (): ModelSpec[] => availableModels(),
  },
};
