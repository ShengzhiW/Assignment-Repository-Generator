/**
 * Assignment Repos from a Google Form
 * ===================================
 * A lightweight replacement for GitHub Classroom's assignment invitation links,
 * built on a Google Form and Google Apps Script.
 *
 * A student fills in the form with their GitHub username and picks an
 * assignment. This script creates a PRIVATE repository for them in your GitHub
 * organization from that assignment's template repository, gives them Write
 * access, and emails them the link.
 *
 * Full setup instructions are in README.md.
 *
 * HOW ASSIGNMENTS ARE DEFINED
 *   There is no assignment list in this file. Every repository in CONFIG.ORG
 *   that has "Template repository" ticked in its Settings (and is not archived)
 *   is an open assignment.
 *     - Dropdown label  = the template repo's description (or its name if the
 *                         description is empty)
 *     - Student repo    = <template repo name>-<GitHub username>
 *     - To close an assignment, untick "Template repository" or archive the
 *       template repo. Repos students already have are not affected.
 *   The form's dropdown is rebuilt from GitHub every SYNC_INTERVAL_MINUTES, from
 *   the form editor (puzzle-piece icon > Repo tools > Refresh assignments), or
 *   whenever you run syncAssignmentDropdown() by hand.
 *
 * WHAT HAPPENS ON EACH FORM SUBMISSION (onFormSubmitHandler)
 *   1. Read the GitHub username and chosen assignment from the response.
 *   2. Confirm the assignment's template repo is still open on GitHub.
 *   3. Confirm the GitHub account exists (and, optionally, is on the roster in
 *      CONFIG.ALLOWED_USERNAMES).
 *   4. Optionally confirm the account is already a member of the org. If not,
 *      email the student asking them to contact you, and stop.
 *   5. If the student already has a repo for this assignment, make sure they
 *      still have access and re-send the link. Otherwise create a private repo
 *      from the template and add the student with CONFIG.PERMISSION access.
 *   6. Email the result. Problems the student can fix (a typo in the username,
 *      a closed assignment, ...) go to the student. Unexpected errors go to
 *      CONFIG.INSTRUCTOR_EMAIL with the full details.
 *
 * QUICK SETUP (see README.md for the detailed version)
 *   1. In the form editor: ⋮ menu > Apps Script. Paste this file into Code.gs.
 *   2. Edit CONFIG below.
 *   3. Project Settings > Script Properties: add GITHUB_TOKEN = <your token>.
 *   4. Run testSetup(), then syncAssignmentDropdown(), then installTrigger().
 *
 * GITHUB TOKEN (fine-grained personal access token, created by an org owner)
 *   Resource owner:      your organization
 *   Repository access:   All repositories (so it covers repos created later)
 *   Repository permissions:
 *     Administration     Read and write   create repos, add collaborators
 *     Contents           Read-only        copy the template
 *     Metadata           Read-only        added automatically
 *   Organization permissions:
 *     Members            Read-only        check org membership
 *
 * Requires the V8 Apps Script runtime (the default for new projects).
 */

/* ==================================================================== */
/* CONFIGURATION: edit this section                                      */
/* ==================================================================== */

const CONFIG = {
  /* ---- GitHub organization ------------------------------------------ */

  // Your organization's login: the part after github.com/ in its URL.
  ORG: 'your-org-name',

  // How the organization is named in the "not a member yet" email,
  // e.g. 'CS 101 Fall 2026'.
  ORG_DISPLAY_NAME: 'Your Course',

  // Access level each student gets on their own repo. GitHub's options are
  // 'pull' (Read), 'triage', 'push' (Write), 'maintain' and 'admin'.
  // 'push' lets students push code but not change visibility, delete the
  // repo, or add other people.
  PERMISSION: 'push',

  // true:  only create repos for accounts that are already members of ORG.
  //        Anyone else gets an email asking them to contact you.
  // false: create a repo for any GitHub account. Non-members are added as
  //        outside collaborators and must accept an emailed invitation.
  REQUIRE_ORG_MEMBERSHIP: true,

  // Optional roster of allowed GitHub usernames (not case sensitive),
  // e.g. ['octocat', 'monalisa']. Leave empty to allow anyone who can submit
  // the form.
  ALLOWED_USERNAMES: [],

  // Template repos to leave OUT of the dropdown (exact repo names), e.g. a
  // course-wide starter you don't want students to pick.
  EXCLUDE_TEMPLATES: [],

  /* ---- Google Form --------------------------------------------------- */

  // Must match the form's question titles exactly. (Reading answers is
  // forgiving about case and a trailing "?" or ":", but the dropdown sync
  // looks for an exact title and creates a new question if it finds none.)
  USERNAME_QUESTION: 'GitHub username',
  ASSIGNMENT_QUESTION: 'Select Your Assignment',

  // How often the dropdown refreshes from GitHub, in minutes:
  // 5, 10, 15, 30, or a multiple of 60.
  SYNC_INTERVAL_MINUTES: 15,

  // Shown as the only dropdown choice when no assignments are open.
  NO_ASSIGNMENTS_LABEL: 'No assignments are open right now',

  /* ---- Email --------------------------------------------------------- */

  // Receives the full error report whenever provisioning fails unexpectedly
  // (expired token, missing permission, GitHub outage, ...). The test*Email()
  // functions also send their samples here.
  INSTRUCTOR_EMAIL: 'instructor@example.edu',

  // Who students are told to contact in their emails, shown as
  // "CONTACT_NAME (CONTACT_EMAIL)". CONTACT_EMAIL falls back to
  // INSTRUCTOR_EMAIL when left empty.
  CONTACT_NAME: 'your instructor',
  CONTACT_EMAIL: '',

  // Added to the start of every email subject, e.g. '[CS 101]'. Can be ''.
  EMAIL_SUBJECT_PREFIX: '[Course]',

  // Optional image at the top of student emails. Use ONE of these, or neither:
  //   HEADER_IMAGE_URL: a public https link to a PNG/JPG
  //   HEADER_IMAGE_DRIVE_FILE_ID: the ID of an image in your Google Drive
  //     (from its link: drive.google.com/file/d/<THIS PART>/view)
  HEADER_IMAGE_URL: '',
  HEADER_IMAGE_DRIVE_FILE_ID: '',
  HEADER_IMAGE_ALT: '', // alt text for the image, e.g. your course name
};

/* ==================================================================== */
/* Form submission                                                       */
/* ==================================================================== */

/**
 * Runs on every form submission (installed by installTrigger()).
 *
 * Every outcome ends in an email: the repo link to the student on success,
 * an explanation to the student for problems they can fix, and a full error
 * report to CONFIG.INSTRUCTOR_EMAIL for anything else (see notifyFailure).
 *
 * @param {GoogleAppsScript.Events.FormsOnFormSubmit} e  The form-submit event.
 */
function onFormSubmitHandler(e) {
  const response = e.response;
  const studentEmail = response.getRespondentEmail(); // '' if emails aren't collected
  const answers = readAnswers(response);
  const username = answers.username;
  const assignment = answers.assignment;

  // Process one submission at a time, so two quick submissions from the same
  // student can't both see "no repo yet" and race to create it. Waits up to
  // 30 seconds for an earlier submission to finish.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!assignment || !username) {
      // A form setup problem rather than a student mistake, so it is reported
      // to the instructor along with every question/answer that was received.
      throw new Error('Could not find the ' + (!assignment ? 'assignment' : 'username') +
        ' answer in this submission. Questions received: ' + answers.debug +
        '. Check CONFIG.USERNAME_QUESTION / CONFIG.ASSIGNMENT_QUESTION, then run syncAssignmentDropdown().');
    }
    const result = provision(username, assignment);
    notifyStudent(studentEmail, assignment, result);
  } catch (err) {
    notifyFailure(studentEmail, username, assignment, err);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Pulls the GitHub username and the chosen assignment out of a form response.
 *
 * Question titles are matched loosely: case, surrounding spaces and a trailing
 * "?", ":" or "*" are ignored. If no title matches, it falls back to the form's
 * only dropdown/multiple-choice question for the assignment, and the form's
 * only short-answer question for the username.
 *
 * @param {GoogleAppsScript.Forms.FormResponse} response
 * @return {{username: string, assignment: string, debug: string}}
 *     `debug` lists every question and answer received, for error reports.
 */
function readAnswers(response) {
  const norm = function (s) { return String(s || '').trim().replace(/[?:*]+$/, '').trim().toLowerCase(); };
  const wantUser = norm(CONFIG.USERNAME_QUESTION);
  const wantAssign = norm(CONFIG.ASSIGNMENT_QUESTION);

  let username = '', assignment = '';
  const lists = [], texts = [], debug = [];

  response.getItemResponses().forEach(function (r) {
    const item = r.getItem();
    const type = item.getType();
    const title = norm(item.getTitle());
    const value = String(r.getResponse() || '').trim();
    debug.push('"' + item.getTitle() + '" (' + type + ') = "' + value + '"');

    // Primary match: by question title.
    if (title === wantUser) username = value;
    else if (title === wantAssign) assignment = value;

    // Collected for the fallback below.
    if (type === FormApp.ItemType.LIST || type === FormApp.ItemType.MULTIPLE_CHOICE) lists.push(value);
    if (type === FormApp.ItemType.TEXT) texts.push(value);
  });

  // Fallback: if exactly one question of the right type exists, use it.
  if (!assignment && lists.length === 1) assignment = lists[0];
  if (!username && texts.length === 1) username = texts[0];

  return { username: username, assignment: assignment, debug: debug.join('; ') || '(none)' };
}

/* ==================================================================== */
/* Assignment discovery (from GitHub template repos)                     */
/* ==================================================================== */

/**
 * Returns the open assignments: every non-archived template repo in ORG,
 * minus EXCLUDE_TEMPLATES, sorted by repo name in natural order (so "2.2"
 * comes before "2.10").
 *
 * Reads at most 20 pages of 100 repos (2,000 repos in total).
 *
 * @return {Array<{label: string, template: string}>}
 *     label    = text shown in the dropdown (the repo description, or its name)
 *     template = the template repo's name
 */
function discoverAssignments() {
  const excluded = CONFIG.EXCLUDE_TEMPLATES.map(function (s) { return s.toLowerCase(); });
  const repos = [];
  for (let page = 1; page <= 20; page++) {
    const res = gh('GET', '/orgs/' + CONFIG.ORG + '/repos?type=all&per_page=100&page=' + page);
    check(res, 'List org repos');
    repos.push.apply(repos, res.body || []);
    if (!res.body || res.body.length < 100) break; // last page
  }

  const templates = repos
    .filter(function (r) { return r.is_template && !r.archived && excluded.indexOf(r.name.toLowerCase()) === -1; })
    .sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); });

  // Label = description, or repo name if there's no description.
  const list = templates.map(function (r) {
    const desc = String(r.description || '').trim();
    return { label: desc || r.name, template: r.name };
  });

  // Dropdown labels must be unique. If two templates share a description,
  // append the repo name to both, e.g. "Lab 1 (lab1-section-a)".
  const counts = {};
  list.forEach(function (a) { counts[a.label] = (counts[a.label] || 0) + 1; });
  list.forEach(function (a) { if (counts[a.label] > 1) a.label = a.label + ' (' + a.template + ')'; });

  return list;
}

/**
 * Saves the label -> template mapping behind the current dropdown, so a
 * submission can be matched to its template without another GitHub search.
 * Stored in the ASSIGNMENT_MAP script property.
 *
 * @param {Array<{label: string, template: string}>} list
 */
function saveAssignmentMap(list) {
  const map = {};
  list.forEach(function (a) { map[a.label] = a.template; });
  PropertiesService.getScriptProperties().setProperty('ASSIGNMENT_MAP', JSON.stringify(map));
}

/**
 * Finds the template repo for a dropdown label and confirms it is still open.
 *
 * A student may have loaded the form before the last refresh, so the label
 * is looked up in the saved mapping first, then live on GitHub, and the
 * template is always re-checked on GitHub before use.
 *
 * @param {string} label  The dropdown choice the student submitted.
 * @return {string}       The template repo's name.
 * @throws {UserError}    If no assignments are open or this one has closed.
 */
function resolveTemplate(label) {
  if (label === CONFIG.NO_ASSIGNMENTS_LABEL) {
    throw new UserError('There are no assignments open right now.');
  }

  let map = {};
  try { map = JSON.parse(PropertiesService.getScriptProperties().getProperty('ASSIGNMENT_MAP') || '{}'); } catch (_) {}
  let template = map[label];

  if (!template) {
    // Not in the saved mapping (e.g. the description changed since the last
    // sync): look it up live.
    const live = discoverAssignments().filter(function (a) { return a.label === label; })[0];
    if (live) template = live.template;
  }
  if (!template) {
    throw new UserError('"' + label + '" is no longer accepting new repositories.');
  }

  // Confirm the template still exists, is still a template, and isn't archived.
  // Note: a token that can't see the repo also gets a 404 here.
  const repo = gh('GET', '/repos/' + CONFIG.ORG + '/' + template);
  if (repo.code === 404 || (repo.body && (!repo.body.is_template || repo.body.archived))) {
    throw new UserError('"' + label + '" is no longer accepting new repositories.');
  }
  check(repo, 'Look up template');
  return repo.body.name;
}

/**
 * Rewrites the form's assignment dropdown from the template repos on GitHub.
 *
 * Creates the dropdown question (titled CONFIG.ASSIGNMENT_QUESTION, required,
 * at the end of the form) if it doesn't exist. The form is only edited when
 * the list of choices has actually changed. Runs on a timer after
 * installTrigger(); you can also run it by hand to update right away.
 *
 * @return {{changed: boolean, labels: string[], open: number}}
 *     open = number of open assignments (0 when only NO_ASSIGNMENTS_LABEL shows)
 */
function syncAssignmentDropdown() {
  const form = getForm();
  const list = discoverAssignments();
  const labels = list.length ? list.map(function (a) { return a.label; }) : [CONFIG.NO_ASSIGNMENTS_LABEL];

  let item = form.getItems().filter(function (i) {
    return i.getTitle().trim() === CONFIG.ASSIGNMENT_QUESTION;
  })[0];

  let dropdown;
  if (!item) {
    dropdown = form.addListItem().setTitle(CONFIG.ASSIGNMENT_QUESTION).setRequired(true);
  } else if (item.getType() === FormApp.ItemType.LIST) {
    dropdown = item.asListItem();
  } else {
    throw new Error('"' + CONFIG.ASSIGNMENT_QUESTION + '" exists but is not a dropdown. Delete it and run this again.');
  }

  saveAssignmentMap(list);

  // Only touch the form if something changed.
  const current = dropdown.getChoices().map(function (c) { return c.getValue(); });
  if (current.join('\n') !== labels.join('\n')) {
    dropdown.setChoiceValues(labels);
    console.log('Dropdown updated: ' + labels.join(' | '));
    return { changed: true, labels: labels, open: list.length };
  }
  console.log('Dropdown already up to date: ' + labels.join(' | '));
  return { changed: false, labels: labels, open: list.length };
}

/* ==================================================================== */
/* Form editor menu                                                      */
/* ==================================================================== */

/**
 * Adds "Repo tools" to the form editor. Google Forms puts it under the
 * puzzle-piece (add-ons) icon in the top toolbar; choosing it opens a window,
 * titled with this Apps Script project's name, containing
 * "Refresh assignments". This is a simple trigger: Google runs it
 * automatically whenever an editor opens the form.
 */
function onOpen() {
  FormApp.getUi()
    .createMenu('Repo tools')
    .addItem('Refresh assignments', 'refreshAssignmentsFromMenu')
    .addToUi();
}

/**
 * Runs when you click "Refresh assignments" (puzzle-piece icon > Repo tools).
 * Syncs the dropdown, then shows "Assignments updated" or "Already up to
 * date" with the list of open assignments, or the error if the sync failed.
 */
function refreshAssignmentsFromMenu() {
  const ui = FormApp.getUi();
  try {
    const r = syncAssignmentDropdown();
    ui.alert(
      r.changed ? 'Assignments updated' : 'Already up to date',
      (r.open ? r.open + ' open assignment(s):\n\n' : '') + r.labels.join('\n') +
        (r.changed ? '\n\nReload the form preview to see the change.' : ''),
      ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Could not refresh assignments', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * Returns the form this script is attached to.
 *
 * When there is an active form (running from the form's script editor), its
 * ID is remembered in the FORM_ID script property. When there isn't (e.g. a
 * time-driven trigger), the remembered ID is used instead.
 *
 * @return {GoogleAppsScript.Forms.Form}
 */
function getForm() {
  const form = FormApp.getActiveForm();
  if (form) {
    PropertiesService.getScriptProperties().setProperty('FORM_ID', form.getId());
    return form;
  }
  const id = PropertiesService.getScriptProperties().getProperty('FORM_ID');
  if (!id) throw new Error('Run installTrigger() from the form\'s script editor first.');
  return FormApp.openById(id);
}

/* ==================================================================== */
/* Core logic                                                            */
/* ==================================================================== */

/**
 * A problem the student can fix themselves (bad username, closed assignment,
 * not on the roster). notifyFailure() emails the message to the student
 * instead of reporting it to the instructor.
 */
class UserError extends Error {
  /**
   * @param {string} message   Explanation shown to the student.
   * @param {string=} followUp Closing line of the student's email. Defaults to
   *                           "Please fix this and submit the form again."
   */
  constructor(message, followUp) {
    super(message);
    this.name = 'UserError';
    this.followUp = followUp || '';
  }
}

/** Closing line for emails about a username problem. */
const CHECK_USERNAME = 'Please double check the GitHub username you entered and submit the form again.';

/**
 * The GitHub account exists but isn't a member of the org (only thrown when
 * CONFIG.REQUIRE_ORG_MEMBERSHIP is true). The student gets an email asking
 * them to contact you to be added.
 */
class NotMemberError extends Error {
  /** @param {string} login  The GitHub username, with GitHub's capitalization. */
  constructor(login) {
    super(login + ' is not a member of ' + CONFIG.ORG);
    this.name = 'NotMemberError';
    this.login = login;
  }
}

/**
 * Creates (or finds) a student's repo for an assignment and gives them access.
 *
 * Never creates a second repo: if <template>-<login> already exists, the
 * student's access is checked and repaired, and the existing repo is returned.
 *
 * @param {string} rawUsername      Username as typed (a profile URL or
 *                                  "@username" also works).
 * @param {string} assignmentLabel  The dropdown choice the student submitted.
 * @return {{login: string, repoName: string, url: string, created: boolean, invited: boolean}}
 *     created = a new repo was made; invited = the student must accept a
 *     GitHub invitation before they can open it.
 * @throws {UserError|NotMemberError|Error}
 */
function provision(rawUsername, assignmentLabel) {
  const template = resolveTemplate(assignmentLabel);

  // GitHub usernames: 1-39 characters, letters/digits/single hyphens,
  // no hyphen at the start or end.
  const cleaned = cleanUsername(rawUsername);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(cleaned)) {
    throw new UserError(String(rawUsername).trim() + ' is not a valid GitHub username, so your assignment repository could not be created.', CHECK_USERNAME);
  }

  // Confirm the account exists and get its exact capitalization.
  const user = gh('GET', '/users/' + cleaned);
  if (user.code === 404) throw new UserError('No GitHub account named ' + cleaned + ' exists, so your assignment repository could not be created.', CHECK_USERNAME);
  check(user, 'Look up user');
  const login = user.body.login;

  // Optional roster check.
  if (CONFIG.ALLOWED_USERNAMES.length) {
    const roster = CONFIG.ALLOWED_USERNAMES.map(function (s) { return s.toLowerCase(); });
    if (roster.indexOf(login.toLowerCase()) === -1) {
      throw new UserError('The GitHub account ' + login + ' is not on the class roster, so your assignment repository could not be created.');
    }
  }

  // Stop here if the student isn't in the org yet.
  if (CONFIG.REQUIRE_ORG_MEMBERSHIP && !isOrgMember(login)) {
    throw new NotMemberError(login);
  }

  const repoName = template + '-' + login;
  if (repoName.length > 100) {
    throw new Error('Repo name "' + repoName + '" is longer than GitHub\'s 100-character limit. Shorten the template repo name.');
  }
  const repoPath = '/repos/' + CONFIG.ORG + '/' + repoName;

  // 1. Does this student's repo already exist? If so, never create another one.
  const existing = gh('GET', repoPath);
  if (existing.code === 200) {
    const url = existing.body.html_url; // follows renames
    const access = ensureAccess(repoPath, login);
    return { login: login, repoName: existing.body.name, url: url, created: false, invited: access.pendingInvite };
  }
  if (existing.code !== 404) check(existing, 'Look up repo');

  // 2. No repo yet: create it from the template (default branch only).
  const gen = gh('POST', '/repos/' + CONFIG.ORG + '/' + template + '/generate', {
    owner: CONFIG.ORG,
    name: repoName,
    private: true,
    include_all_branches: false,
  });
  check(gen, 'Create repo from template');

  // 3. Add the student. GitHub generates the repo asynchronously, so retry
  //    for up to ~10 seconds while it still returns 404.
  let collab;
  for (let i = 0; i < 5; i++) {
    collab = gh('PUT', repoPath + '/collaborators/' + login, { permission: CONFIG.PERMISSION });
    if (collab.code !== 404) break;
    Utilities.sleep(2000);
  }
  check(collab, 'Add collaborator');

  return {
    login: login,
    repoName: repoName,
    url: gen.body.html_url,
    created: true,
    invited: collab.code === 201, // 201 = invitation sent; 204 = added directly (org member)
  };
}

/**
 * Checks whether a GitHub account is a member of CONFIG.ORG.
 *
 * @param {string} login
 * @return {boolean}  true for HTTP 204, false for 404.
 * @throws {Error}    For any other response (usually a missing token permission).
 */
function isOrgMember(login) {
  const m = gh('GET', '/orgs/' + CONFIG.ORG + '/members/' + login);
  if (m.code === 204) return true;
  if (m.code === 404) return false;
  throw new Error('Check org membership failed (HTTP ' + m.code + '). ' +
    'Make sure the token has Organization > Members: Read-only. ' + JSON.stringify(m.body));
}

/**
 * For a repo that already exists: makes sure the student can get in, without
 * sending a duplicate invitation.
 *
 * @param {string} repoPath  API path of the repo, e.g. /repos/<org>/<name>.
 * @param {string} login     The student's GitHub username.
 * @return {{pendingInvite: boolean}}  true if the student still needs to
 *     accept an invitation.
 */
function ensureAccess(repoPath, login) {
  // Already a collaborator? (204 = yes, 404 = no)
  const isCollab = gh('GET', repoPath + '/collaborators/' + login);
  if (isCollab.code === 204) return { pendingInvite: false };
  if (isCollab.code !== 404) check(isCollab, 'Check collaborator');

  // Invitation already sent but not accepted?
  const invites = gh('GET', repoPath + '/invitations?per_page=100');
  check(invites, 'List invitations');
  const pending = (invites.body || []).some(function (inv) {
    return inv.invitee && inv.invitee.login.toLowerCase() === login.toLowerCase();
  });
  if (pending) return { pendingInvite: true };

  // Repo exists but the student lost access (e.g. you removed them): re-add.
  const collab = gh('PUT', repoPath + '/collaborators/' + login, { permission: CONFIG.PERMISSION });
  check(collab, 'Re-add collaborator');
  return { pendingInvite: collab.code === 201 };
}

/**
 * Normalizes what a student typed into a bare username. Accepts
 * "octocat", "@octocat", "https://github.com/octocat" and
 * "github.com/octocat/some-repo" (everything after the username is dropped).
 *
 * @param {*} raw
 * @return {string}
 */
function cleanUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/[\/?#].*$/, '')
    .replace(/^@/, '');
}

/* ==================================================================== */
/* GitHub API helpers                                                    */
/* ==================================================================== */

/**
 * Calls the GitHub REST API with the token in the GITHUB_TOKEN script
 * property. Never throws on HTTP errors; callers inspect `code`.
 *
 * @param {string} method   'GET', 'POST', 'PUT', ...
 * @param {string} path     API path starting with '/', e.g. '/orgs/my-org'.
 * @param {Object=} payload Sent as a JSON body when given.
 * @return {{code: number, body: *}}  HTTP status and parsed JSON body (or raw
 *     text if the body isn't JSON, or null if it's empty).
 */
function gh(method, path, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('The GITHUB_TOKEN script property is not set.');

  const options = {
    method: method.toLowerCase(),
    muteHttpExceptions: true, // return 4xx/5xx responses instead of throwing
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  const res = UrlFetchApp.fetch('https://api.github.com' + path, options);
  const text = res.getContentText();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  return { code: res.getResponseCode(), body: body };
}

/**
 * Throws a descriptive Error if a gh() response isn't a success (status >= 300).
 *
 * @param {{code: number, body: *}} res
 * @param {string} what  Short description of the call, used in the error message.
 */
function check(res, what) {
  if (res.code >= 300) {
    throw new Error(what + ' failed (HTTP ' + res.code + '): ' + JSON.stringify(res.body));
  }
}

/* ==================================================================== */
/* Email                                                                 */
/* All student emails are sent from the Google account that installed    */
/* the triggers, as both plain text and HTML (with the header image).    */
/* ==================================================================== */

/** "CONTACT_NAME (email)" for the person students should contact. */
function contactText() {
  const email = CONFIG.CONTACT_EMAIL || CONFIG.INSTRUCTOR_EMAIL;
  return CONFIG.CONTACT_NAME ? CONFIG.CONTACT_NAME + ' (' + email + ')' : email;
}

/** Adds CONFIG.EMAIL_SUBJECT_PREFIX (if set) to the start of an email subject. */
function subject(text) {
  return (CONFIG.EMAIL_SUBJECT_PREFIX ? CONFIG.EMAIL_SUBJECT_PREFIX + ' ' : '') + text;
}

/**
 * Success email: the repo link, plus the invitation link when the student
 * still has to accept one. If no email was collected, only logs the URL.
 *
 * @param {string} email       Student's email ('' if not collected).
 * @param {string} assignment  The dropdown label they chose.
 * @param {{login: string, url: string, created: boolean, invited: boolean}} r
 *     Result of provision().
 */
function notifyStudent(email, assignment, r) {
  if (!email) { console.log('Provisioned ' + r.url + ' (no student email collected)'); return; }

  const intro = r.created
    ? 'Your repository for "' + assignment + '" (GitHub user: ' + r.login + ') is ready:'
    : 'You already have a repository for "' + assignment + '" (GitHub user: ' + r.login +
      '), so a new one was not created. Here it is:';
  const invite = r.invited
    ? 'First, accept the invitation here (you must be signed in to GitHub as ' + r.login + '):'
    : '';
  const outro = 'The repository is private. Only you and the teaching team can see it. ' +
    'Please let ' + contactText() + ' know if you have any issues accessing your repository.';

  // Plain-text version (for email clients that don't show HTML)
  let text = 'Hi ' + email + ',\n\n' + intro + '\n' + r.url + '\n\n';
  if (invite) text += invite + '\n' + r.url + '/invitations\n\n';
  text += outro + '\n';

  // HTML version with header image
  const header = headerImage();
  const link = function (url) {
    return '<a href="' + esc(url) + '" style="color:#0969da;word-break:break-all;">' + esc(url) + '</a>';
  };
  let html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:600px;">' +
    (header.html ? '<div style="margin-bottom:20px;">' + header.html + '</div>' : '') +
    '<p>Hi ' + esc(email) + ',</p>' +
    '<p>' + esc(intro) + '<br>' + link(r.url) + '</p>';
  if (invite) html += '<p>' + esc(invite) + '<br>' + link(r.url + '/invitations') + '</p>';
  html += '<p>' + esc(outro) + '</p></div>';

  const options = { htmlBody: html };
  if (header.blob) options.inlineImages = { header: header.blob };
  MailApp.sendEmail(email, subject('Your repo for ' + assignment), text, options);
}

/**
 * Email for students whose GitHub account isn't in the org yet. Asks them to
 * send their username to the contact person so they can be added.
 *
 * @param {string} email       Student's email ('' if not collected).
 * @param {string} assignment  The dropdown label they chose.
 * @param {string} login       Their GitHub username.
 */
function notifyNotMember(email, assignment, login) {
  if (!email) { console.log(login + ' is not an org member (no student email collected)'); return; }

  const p1 = 'Your GitHub account ' + login + " isn't part of the " + CONFIG.ORG_DISPLAY_NAME +
    ' organization yet, so your assignment repository for "' + assignment + '" could not be created.';
  const p2 = 'Please reach out to ' + contactText() + ' with your GitHub username so you can be added.';

  // Plain-text version
  const text = 'Hi ' + email + ',\n\n' + p1 + '\n\n' + p2 + '\n';

  // HTML version with header image
  const header = headerImage();
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:600px;">' +
    (header.html ? '<div style="margin-bottom:20px;">' + header.html + '</div>' : '') +
    '<p>Hi ' + esc(email) + ',</p>' +
    '<p>' + esc(p1) + '</p>' +
    '<p>' + esc(p2) + '</p></div>';

  const options = { htmlBody: html };
  if (header.blob) options.inlineImages = { header: header.blob };
  MailApp.sendEmail(email, subject('Your repo for ' + assignment + ' could not be created'), text, options);
}

/**
 * Email for problems the student can fix (e.g. a GitHub account that doesn't
 * exist). Layout: header image, greeting, message, closing line.
 *
 * @param {string} email       Student's email ('' if not collected).
 * @param {string} assignment  The dropdown label they chose.
 * @param {string} message     What went wrong.
 * @param {string=} followUp   Closing line. Defaults to
 *                             "Please fix this and submit the form again."
 */
function notifyProblem(email, assignment, message, followUp) {
  if (!email) { console.log('Problem (no student email collected): ' + message); return; }

  const p2 = followUp || 'Please fix this and submit the form again.';

  // Plain-text version
  const text = 'Hi ' + email + ',\n\n' + message + '\n' + p2 + '\n';

  // HTML version: header image, then greeting, then message
  const header = headerImage();
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:600px;">' +
    (header.html ? '<div style="margin-bottom:20px;">' + header.html + '</div>' : '') +
    '<p>Hi ' + esc(email) + ',</p>' +
    '<p>' + esc(message) + '<br>' + esc(p2) + '</p></div>';

  const options = { htmlBody: html };
  if (header.blob) options.inlineImages = { header: header.blob };
  MailApp.sendEmail(email, subject('Problem creating your repo for ' + assignment), text, options);
}

/**
 * Returns the email header image as HTML. A Drive image is attached inline
 * (referenced as cid:header); a URL image is linked directly.
 *
 * @return {{html: string, blob: ?GoogleAppsScript.Base.Blob}}  Empty html and
 *     null blob when no header image is configured.
 */
function headerImage() {
  const style = 'display:block;width:100%;max-width:600px;height:auto;border:0;';
  const alt = esc(CONFIG.HEADER_IMAGE_ALT || '');
  if (CONFIG.HEADER_IMAGE_DRIVE_FILE_ID) {
    const blob = DriveApp.getFileById(CONFIG.HEADER_IMAGE_DRIVE_FILE_ID).getBlob();
    return { html: '<img src="cid:header" alt="' + alt + '" style="' + style + '">', blob: blob };
  }
  if (CONFIG.HEADER_IMAGE_URL) {
    return { html: '<img src="' + esc(CONFIG.HEADER_IMAGE_URL) + '" alt="' + alt + '" style="' + style + '">', blob: null };
  }
  return { html: '', blob: null };
}

/** Escapes text for safe use inside HTML. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Routes an error from onFormSubmitHandler to the right person:
 *   NotMemberError -> student, "ask to be added to the org" email
 *   UserError      -> student, explanation of what to fix
 *   anything else  -> instructor gets the full error and stack trace; the
 *                     student gets a short "we've been notified" note
 * Every error is also logged (Apps Script editor > Executions).
 *
 * @param {string} email       Student's email ('' if not collected).
 * @param {string} username    Username as submitted.
 * @param {string} assignment  Assignment label as submitted.
 * @param {*} err
 */
function notifyFailure(email, username, assignment, err) {
  console.error(err);
  if (err instanceof NotMemberError) {
    notifyNotMember(email, assignment, err.login);
    return;
  }
  if (err instanceof UserError) {
    notifyProblem(email, assignment, err.message, err.followUp);
    return;
  }
  MailApp.sendEmail(CONFIG.INSTRUCTOR_EMAIL, 'Repo provisioning failed',
    'Student email: ' + (email || '(not collected)') + '\n' +
    'Username: ' + username + '\nAssignment: ' + assignment + '\n\n' +
    (err && err.stack ? err.stack : String(err)));
  if (email) {
    MailApp.sendEmail(email, subject('Problem creating your repo for ' + assignment),
      'Something went wrong on our end. Your instructor has been notified and will follow up.');
  }
}

/* ==================================================================== */
/* One-time setup and testing (run these from the Apps Script editor)    */
/* ==================================================================== */

/**
 * Checks the token and lists the assignments it finds, with an example
 * student repo name for each. Run this first. Expect HTTP 200 for both checks.
 */
function testSetup() {
  const org = gh('GET', '/orgs/' + CONFIG.ORG);
  console.log('Org access: HTTP ' + org.code);
  const members = gh('GET', '/orgs/' + CONFIG.ORG + '/members?per_page=1');
  console.log('Member check: HTTP ' + members.code +
    (members.code === 200 ? ' (OK)' : ' (add Organization > Members: Read-only to the token)'));

  const list = discoverAssignments();
  if (!list.length) {
    console.log('No open template repos found. Tick "Template repository" in a repo\'s Settings.');
  }
  list.forEach(function (a) {
    const example = a.template + '-example-user';
    console.log('"' + a.label + '"  ->  template ' + a.template + '  ->  e.g. ' + example +
      (example.length > 100 ? '  (TOO LONG, shorten the template name)' : ''));
  });
}

/** Sends CONFIG.INSTRUCTOR_EMAIL a sample "repo ready" email to check the layout. */
function testEmail() {
  const a = discoverAssignments()[0] || { label: 'Example assignment', template: 'example-template' };
  notifyStudent(CONFIG.INSTRUCTOR_EMAIL, a.label, {
    login: 'example-user',
    repoName: a.template + '-example-user',
    url: 'https://github.com/' + CONFIG.ORG + '/' + a.template + '-example-user',
    created: true,
    invited: true,
  });
}

/** Sends CONFIG.INSTRUCTOR_EMAIL a sample "no such GitHub account" email. */
function testProblemEmail() {
  const a = discoverAssignments()[0] || { label: 'Example assignment' };
  notifyProblem(CONFIG.INSTRUCTOR_EMAIL, a.label,
    'No GitHub account named example-user exists, so your assignment repository could not be created.',
    CHECK_USERNAME);
}

/** Sends CONFIG.INSTRUCTOR_EMAIL a sample "not in the org" email. */
function testNotMemberEmail() {
  const a = discoverAssignments()[0] || { label: 'Example assignment' };
  notifyNotMember(CONFIG.INSTRUCTOR_EMAIL, a.label, 'example-user');
}

/**
 * Creates a REAL repo for a test account from the first open assignment,
 * without going through the form. Replace the placeholder with a GitHub
 * account that is in your org, and delete the repo afterwards.
 */
function testProvision() {
  const a = discoverAssignments()[0];
  if (!a) throw new Error('No open template repos found.');
  const result = provision('YOUR-TEST-GITHUB-USERNAME', a.label);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Installs both triggers and refreshes the dropdown once:
 *   - onFormSubmitHandler: runs on every form submission
 *   - syncAssignmentDropdown: runs every CONFIG.SYNC_INTERVAL_MINUTES
 * Run once from the form's script editor. Safe to run again: it removes this
 * script's existing copies of these triggers first.
 */
function installTrigger() {
  const form = getForm();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'onFormSubmitHandler' || fn === 'syncAssignmentDropdown') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('onFormSubmitHandler').forForm(form).onFormSubmit().create();

  const mins = CONFIG.SYNC_INTERVAL_MINUTES;
  const timer = ScriptApp.newTrigger('syncAssignmentDropdown').timeBased();
  if (mins >= 60) timer.everyHours(Math.round(mins / 60)).create();
  else timer.everyMinutes(mins).create();

  syncAssignmentDropdown();
  console.log('Triggers installed: form submit + dropdown sync every ' + mins + ' minutes.');
}
