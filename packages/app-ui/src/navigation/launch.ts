/** Owned by App, outside the keyed authenticated subtree. A launch deep link
 * belongs only to the first committed navigation session, even if profile setup
 * delays mounting it. Later logins never inherit the previous session's URL. */
export class NavigationLaunch {
  private consumed = false;

  constructor(private readonly url: string) {}

  get initialUrl() {
    return this.consumed ? "/chat" : this.url;
  }

  consume() {
    this.consumed = true;
  }
}
