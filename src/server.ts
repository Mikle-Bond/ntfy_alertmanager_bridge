// vim: sts=2:sw=2:ts=2:et
import {z} from "zod";
import axios from "axios";
import jq from "node-jq";
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";

/*
{
  "version": "4",
  "groupKey": <string>,              // key identifying the group of alerts (e.g. to deduplicate)
  "truncatedAlerts": <int>,          // how many alerts have been truncated due to "max_alerts"
  "status": "<resolved|firing>",
  "receiver": <string>,
  "groupLabels": <object>,
  "commonLabels": <object>,
  "commonAnnotations": <object>,
  "externalURL": <string>,           // backlink to the Alertmanager.
  "alerts": [
    {
      "status": "<resolved|firing>",
      "labels": <object>,
      "annotations": <object>,
      "startsAt": "<rfc3339>",
      "endsAt": "<rfc3339>",
      "generatorURL": <string>,      // identifies the entity that caused the alert
      "fingerprint": <string>        // fingerprint to identify the alert
    },
    ...
  ]
}
*/

const AlertScheme = z.object({
  status: z.enum(["resolved", "firing"]),
  labels: z.object({}).catchall(z.string()),
  annotations: z.object({
    summary: z.string(),
    description: z.string(),
  }).partial(),
  generatorURL: z.string().url(),
  fingerprint: z.string(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

type Alert = z.infer<typeof AlertScheme>;

const AlertsScheme = z.object({
  alerts: AlertScheme.array(),
}).catchall(z.unknown());

const QueryScheme = z.object({
  topic: z.string(),
  priority: z.string(),
  tags: z.string(),
  title: z.string(),
}).partial().required({topic: true})

type Query = z.infer<typeof QueryScheme>;

const NotificationScheme = z.object({
  topic: z.string(),
  title: z.string().default("New Alert"),
  tags: z.string().array().optional(),
  message: z.string().default("Alert body"),
  priority: z.number().default(3),
})

type Notification = z.infer<typeof NotificationScheme>;

const ConfigScheme = z.object({
  port: z.number().default(30000),
  ntfyServer: z.string().url().default("http://localhost:30001"),
});

const config = ConfigScheme.parse({
  port: process.env.PORT,
  ntfyServer: process.env.NTFY_SERVER_ADDRESS,
});

const app = new Koa();
const router = new Router();

const options = {
  input: "json",
  output: "json",
};

const runJQ = async (filter: string, data: Alert): Promise<object> => {
  return jq.run(filter, data, options) as Promise<object>;
}

async function constructNotification(query: Query, alert: Alert): Promise<Notification> {
  const awaitableEntries = Object.entries(query).map(
    async ([key, query]) => {
      return runJQ(query, alert).then(value => [key, value])
    }
  );
  return Promise.all(awaitableEntries)
    .then(Object.fromEntries)
    .then(NotificationScheme.parseAsync);
}	

const log = (prefix: string) => <T>(data: T): T => {
  console.log(`msg="${prefix}" payload='${JSON.stringify(data)}'`);
  return data;
}

router
  .get("/", (ctx, next) => {
    ctx.body = "hello world";
  })
  .post("/ntfy_alert", async (ctx, next) => {
    const queryMaybe = await QueryScheme.safeParseAsync(ctx.query);
    if (!queryMaybe.success) {
      ctx.status = 400;
      ctx.body = "Set 'topic' parameter, and verify the query is correct, please.";
      log("Query could not be parsed")(queryMaybe.error);
      return;
    }
    const query = queryMaybe.data;

    const body = await AlertsScheme.safeParseAsync(ctx.request.body);
    if (!body.success) {
      log("Received illformed request")(body.error);
      ctx.status = 400;
      ctx.body = "Alerts not found";
      return;
    }
    const alerts = Object.values(body.data.alerts).map(async (x) => {  
      AlertScheme.parseAsync(x)
      .then(log("Alert object received"))
      .then(async alert => await constructNotification(query, alert))
      .then(log("Notification constructed"))
      .then(async data => await axios.post(config.ntfyServer, data))
      .then(log("Notification sent!"))
      //.then(_ => new Promise(f => setTimeout(f, 1500)))
      .catch(error => {
        log("Error occured for alert")(error);
        ctx.status = error.status || 500;
        ctx.body = "Something went horribly wrong: " + JSON.stringify(error); 
      });
    });
    await Promise.all(alerts)
      .catch(log("Some alerts failed, see previous logs"))
      .finally(()=>console.log("Request processed"));
    ctx.body = "tnx alertmanager";
  });

app
  .use(bodyParser())
  .use(router.routes())
  .use(router.allowedMethods())
  .listen(config.port);

