// The GitHub App boundary. The App is an operator item, so the deployment wires one of three ports:
// the fake for the unit path and development, the fail-fast adapter while the App is absent, or the
// App client once the operator provisions it. Nothing here ever waits on a network call it cannot make.

import type { CommitSha, JobId } from "./ids.ts";

export type GitHubAppConfig = {
	readonly appId: string;
	readonly privateKey: string;
	/** The organization that holds one pushed work repository per job. */
	readonly organization: string;
	readonly apiBase: string;
};

export type GitHubAppConfigInput = Partial<Omit<GitHubAppConfig, "apiBase">> & { readonly apiBase?: string };

export class GitHubAppNotConfigured extends Error {
	readonly code = "GITHUB_APP_NOT_CONFIGURED";
	constructor(detail = "The GitHub App is not configured.") { super(detail); }
}

export class GitHubAppNotImplemented extends Error {
	readonly code = "GITHUB_APP_NOT_IMPLEMENTED";
	constructor() { super("The GitHub App REST client lands with the App itself; no App is provisioned on this machine."); }
}

export type WorkRepo = {
	/** `acquit-forks/invoice-app-<job>`, the repository the frozen commit is pushed to. */
	readonly repository: string;
	readonly remote: string;
	readonly branch: string;
	readonly commit: CommitSha;
};

export type PublishedPullRequest = {
	readonly repository: string;
	readonly pullRequest: number;
	/** The immutable commit the PR head points at. Approval, merge, and the receipt bind to this, never to a moving head. */
	readonly mergeCommit: CommitSha;
	readonly checkRunUrl: string | null;
};

export type WorkRepoRequest = { readonly jobId: JobId; readonly repository: string; readonly frozenCommit: CommitSha };
export type PublishRequest = { readonly jobId: JobId; readonly repository: string; readonly sourceCommit: CommitSha; readonly checkName: string };

/** What the core's outbox needs. */
export interface WorkRepoPort {
	/** Idempotent per job: a retry adopts the existing repository instead of creating a second one. */
	createWorkRepo(request: WorkRepoRequest, requestId: string): Promise<WorkRepo>;
}

/** What the judge needs after a clean run. */
export interface PublisherPort {
	/** Idempotent per job and commit: a retry reuses the branch, the pull request, and the check run. */
	publishVerified(request: PublishRequest, requestId: string): Promise<PublishedPullRequest>;
}

export interface GitHubAppPort extends WorkRepoPort, PublisherPort {}

/** Boundary parse. A partial config is not an error here; it selects the fail-fast adapter. */
export function parseGitHubAppConfig(input: GitHubAppConfigInput | undefined): GitHubAppConfig | null {
	const appId = input?.appId?.trim() ?? "";
	const privateKey = input?.privateKey?.trim() ?? "";
	const organization = input?.organization?.trim() ?? "";
	if (!appId || !privateKey || !organization) return null;
	return { appId, privateKey, organization, apiBase: input?.apiBase?.trim() || "https://api.github.com" };
}

export function missingGitHubNames(input: GitHubAppConfigInput | undefined): readonly string[] {
	return [["GITHUB_APP_ID", input?.appId], ["GITHUB_APP_PRIVATE_KEY", input?.privateKey], ["GITHUB_APP_ORG", input?.organization]]
		.filter(([, value]) => !value?.trim()).map(([name]) => String(name));
}

/** Every call refuses immediately. It never starts a request it cannot authenticate. */
export function unconfiguredGitHubApp(detail = `Missing ${missingGitHubNames({}).join(", ")}.`): GitHubAppPort {
	const fail = (): never => { throw new GitHubAppNotConfigured(detail); };
	return { createWorkRepo: async () => fail(), publishVerified: async () => fail() };
}

export function createGitHubApp(config: GitHubAppConfigInput | undefined): GitHubAppPort {
	const parsed = parseGitHubAppConfig(config);
	if (!parsed) return unconfiguredGitHubApp(`Missing ${missingGitHubNames(config).join(", ")}.`);
	// The App exists but this build has no REST client: refuse by name instead of pretending or hanging.
	const fail = (): never => { throw new GitHubAppNotImplemented(); };
	return { createWorkRepo: async () => fail(), publishVerified: async () => fail() };
}

export type GitHubCall = { readonly kind: "CREATE_WORK_REPO" | "PUBLISH_VERIFIED"; readonly jobId: JobId; readonly requestId: string };

export type FakeGitHubApp = GitHubAppPort & {
	readonly calls: readonly GitHubCall[];
	readonly workRepos: ReadonlyMap<JobId, WorkRepo>;
	readonly pullRequests: ReadonlyMap<JobId, PublishedPullRequest>;
};

/** The unit path and the development app. Deterministic, idempotent, and it records what it was asked to do. */
export function createFakeGitHubApp(options: { readonly organization?: string; readonly firstPullRequest?: number } = {}): FakeGitHubApp {
	const organization = options.organization ?? "acquit-forks";
	const calls: GitHubCall[] = [];
	const workRepos = new Map<JobId, WorkRepo>();
	const pullRequests = new Map<JobId, PublishedPullRequest>();
	let nextPullRequest = options.firstPullRequest ?? 13;
	return {
		calls, workRepos, pullRequests,
		async createWorkRepo(request, requestId) {
			calls.push({ kind: "CREATE_WORK_REPO", jobId: request.jobId, requestId });
			const existing = workRepos.get(request.jobId);
			if (existing) return existing;
			const repository = `${organization}/${workRepoName(request.repository, request.jobId)}`;
			const created: WorkRepo = { repository, remote: `https://github.com/${repository}.git`,
				branch: "main", commit: request.frozenCommit };
			workRepos.set(request.jobId, created);
			return created;
		},
		async publishVerified(request, requestId) {
			calls.push({ kind: "PUBLISH_VERIFIED", jobId: request.jobId, requestId });
			const existing = pullRequests.get(request.jobId);
			if (existing) return existing;
			const published: PublishedPullRequest = { repository: request.repository, pullRequest: nextPullRequest++,
				mergeCommit: request.sourceCommit, checkRunUrl: `https://github.com/${request.repository}/runs/${request.jobId}` };
			pullRequests.set(request.jobId, published);
			return published;
		},
	};
}

/** `invoice-app` plus the job id, so ten lanes never collide on one repository name. */
export function workRepoName(repository: string, jobId: JobId): string {
	const name = repository.split("/").at(-1) ?? repository;
	return `${name}-${jobId.replace(/^job_/, "")}`;
}

/** The branch the verified tree is pushed to on the client repository. */
export function verifiedBranch(jobId: JobId): string {
	return `acquit/${jobId}`;
}
