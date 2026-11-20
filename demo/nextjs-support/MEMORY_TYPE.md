# Set up the `customer_environment` memory type

The structured part of this demo needs a custom memory type on your Redis Agent Memory service. Without it the chat still works, but the panel shows only free-text facts and the staff **Account health** page stays empty.

**Create it before you seed.** Extraction only fills a type that exists and is enabled when the conversation is processed.

## Steps

1. In the Redis Cloud console, open **Agent Memory** → your service → **Configuration**.
2. Select **Edit**, then under **Memory types & extraction** select **Add type**.
3. Enter the values below **exactly**. The app looks up the type and its fields by these names, and **names and fields can't be changed after you save**. Getting a name wrong means creating a new service.
4. Make sure the type is **Enabled**, then **Save**.

A service can have at most 3 custom memory types.

## Values

**Name**

```text
customer_environment
```

**Description**

```text
The customer's technical setup for the Waypoint API gateway, as stated in support conversations.
```

**Extraction prompt**

```text
Extract the customer's technical setup for the Waypoint API gateway whenever the user states any of: the gateway region, where their own backend or origin servers run, the runtime or language that calls Waypoint, the Waypoint SDK version, or whether HTTP keep-alive is on or off. Fill only the fields the user actually stated. Treat "we turned keep-alive off" or "disabled keep-alive" as keep_alive_enabled = false. client_runtime is the platform or language of the services that call Waypoint, never a command-line tool such as curl. gateway_region is only the Waypoint gateway's region; where the customer's own services run belongs in client_runtime or origin_location.
```

**Custom Fields**

| Field name | Type | Description |
|------------|------|-------------|
| `gateway_region` | `str` | Waypoint region the customer's gateway runs in, for example us-east or eu-central. |
| `origin_location` | `str` | Where the customer's own backend or origin servers run, for example Frankfurt or us-west. |
| `client_runtime` | `str` | What calls Waypoint, for example AWS Lambda with Node 18, or Go on Kubernetes. |
| `sdk_version` | `str` | Waypoint SDK version the customer uses, for example 3.0 or 3.2.1. |
| `keep_alive_enabled` | `str` | Whether HTTP keep-alive is enabled in the customer's client. |

The same definitions are in [lib/environment.ts](lib/environment.ts). If you change one, change the other.

**Why `keep_alive_enabled` is text, not `bool`:** the demo service has it as `str`, and field types can't change after creation, so the app matches the text value `"false"`. With this prompt, extraction writes `"true"` or `"false"`. Attribute filters are exact and case-sensitive, so `"False"` or `"off"` wouldn't match. If you see other values, edit the extraction prompt (it stays editable) and re-seed under a new `DEMO_RUN`.

## Why the prompt names the wrong fields

Without the last two sentences, extraction tended to file a customer's command-line tool as their runtime ("curl"), and where their own services run as the gateway region. The prompt stays editable after creation. If you change it, re-seed under a new `DEMO_RUN`, because existing records aren't re-extracted.

## Check it worked

Run `npm run seed`. For each customer it prints the memories it found, including a `[customer_environment]` line with the extracted fields, for example:

```text
Harbor Health: 4 memories
  • [customer_environment] … {"client_runtime":"AWS Lambda in us-east with Node 18","sdk_version":"3.0","keep_alive_enabled":"false"}
```

It then checks the values the demo relies on and ends with **Ready to demo** or **Not ready**. If a customer gets no `customer_environment` line within 8 minutes, the script says so. Check that the type is enabled and the extraction cadence is short, then change `DEMO_RUN` and seed again.
