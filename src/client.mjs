import { userRmnMessage } from "@red-cup-engineering/a2a-rmn-part-service";
import { deliverFromEnvironment } from "@red-cup-engineering/activitypub-services-section/deliver";
import { projectRmnActivity } from "@red-cup-engineering/activitypub-services-section/rmn-activity";
import { ACTOR, operationBytes, record } from "./a2a-executor.mjs";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

export async function induceGithubSoftwareProposal(input, {
  origin = process.env.ACTIVITYPUB_ORIGIN,
  identifier = process.env.ACTIVITYPUB_IDENTIFIER,
  keyPath = process.env.ACTIVITYPUB_KEYS_PATH,
  agentCard = process.env.ACTIVITYPUB_A2A_AGENT_CARD,
  recipient = process.env.GITHUB_SOFTWARE_INDUCTION_ACTIVITYPUB_ACTOR,
  inbox = process.env.GITHUB_SOFTWARE_INDUCTION_ACTIVITYPUB_INBOX,
  deliver = deliverFromEnvironment,
  eventTime = new Date().toISOString(),
} = {}) {
  const senderOrigin = required(origin, "ACTIVITYPUB_ORIGIN").replace(/\/$/u, "");
  const senderIdentifier = required(identifier, "ACTIVITYPUB_IDENTIFIER");
  const recipientActor = required(recipient, "GITHUB_SOFTWARE_INDUCTION_ACTIVITYPUB_ACTOR");
  const request = record({ type: "GithubSoftwareInductionRequest", provider: ACTOR, input });
  const bytes = operationBytes(request), message = userRmnMessage(bytes);
  const activity = projectRmnActivity({
    type: "Create", origin: senderOrigin, identifier: senderIdentifier,
    recipient: recipientActor, objectBytes: bytes, a2aMessage: message,
    a2aRole: "ROLE_USER", agentCard: required(agentCard, "ACTIVITYPUB_A2A_AGENT_CARD"), eventTime,
  });
  const delivery = await deliver(activity, {
    origin: senderOrigin, identifier: senderIdentifier,
    keyPath: required(keyPath, "ACTIVITYPUB_KEYS_PATH"), recipient: recipientActor,
    inbox: required(inbox, "GITHUB_SOFTWARE_INDUCTION_ACTIVITYPUB_INBOX"),
  });
  return Object.freeze({ disposition: "submitted", operation: request.id, request: request.id, activity: activity.id, delivery });
}
