#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { induceGithubSoftwareProposal } from "../src/client.mjs";

const source = process.env.GITHUB_SOFTWARE_INDUCTION_INPUT_JSON ?? readFileSync(0, "utf8");
let input;
try { input = JSON.parse(source); }
catch (error) { throw new TypeError(`GitHub induction input is not JSON: ${error.message}`); }
const receipt = await induceGithubSoftwareProposal(input);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
