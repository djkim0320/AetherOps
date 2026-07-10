import type { OntologyConstraint, OntologyEntity, OntologyRelation } from "../../shared/types.js";

export interface OntologyGraphBuildResult {
  entities: OntologyEntity[];
  relations: OntologyRelation[];
  constraints: OntologyConstraint[];
}
