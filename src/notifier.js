const jwt = require("jsonwebtoken");
const axios = require("axios");
var log4js = require("log4js");
const date = require('date-and-time');
var logger = log4js.getLogger('security-advisor-notification-webhook');
logger.level = "info";

const webhookInternalErrorResponse = { err: "WebHook Internal Error." };

async function obtainAccessToken(iamTokenURL, apiKey) {
  const requestBody = `grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=${apiKey}&response_type=cloud_iam`;
  const config = {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    }
  };
  const { data } = await axios.post(iamTokenURL, requestBody, config);
  return `Bearer ${data.access_token}`;
}

async function downloadPublicKey(accessToken, accountId, params) {
  try {
    const config = {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: accessToken
      }
    };

    const url = `${params.notificationChannelUrl
      }/v1/${accountId}/notifications/public_key`;
    const response = await axios.get(url, config);
    logger.info(`Downloaded public key for account ${accountId}`);
    return response.data.publicKey;
  } catch (err) {
    logger.error(
      `Error while downloading public key for account ${accountId} : ${JSON.stringify(
        err
      )}`
    );
    throw err;
  }
}

async function sendToLogDNA(finding, params) {
  try {
    const basicAuth = Buffer.from(`${params.logDNAIngestionKey}:`).toString('base64')
    const config = {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Basic ${basicAuth}`
      }
    };
    const body = {
      "lines": [
        {
          "timestamp": date.format(new Date(), 'YYYY-MM-DDTHH:mm:ss.SSZ', true),
          "line": JSON.stringify(finding),
          "app": "cloud function",
          "level": "INFO",
          "meta": {
            "labels": "IBM Security Advisor"
          }
        }
      ]
    }
    const url = `${params.logDNAEndpoint}/logs/ingest?hostname=security-advisor-notification-webhook&tags=security-advisor&now=${Date.now()}`

    await axios.post(url, body, config);
  } catch (err) {
    logger.error(
      `Error while sending finding ${finding["id"]
      } to logDNA : ${err}`
    );
    throw err;
  }
}

async function sendToEventstream(finding, params) {
  const { Kafka } = require('kafkajs');
  const topic = params.kafkaTopic;
  const brokers = params.kafkaMetadataBrokerList.split(',')
  const kafka = new Kafka({
    clientId: 'security-advisor-notification-webhook',
    kafka_topic: topic,
    brokers: brokers,
    sasl: {
      mechanism: 'plain',
      username: params.kafkaSaslUsername,
      password: params.kafkaSaslPassword
    },
    ssl: true,
    connectionTimeout: 3000,
    authenticationTimeout: 1000,
    reauthenticationThreshold: 10000,
  });
  // 2.Creating Kafka Producer
  const producer = kafka.producer();
  const runProducer = async () => {
    // 3.Connecting producer to kafka broker.
    try {
      await producer.connect()
      await producer.send({
        topic: topic,
        messages:
          [{ value: JSON.stringify(finding) }],
      })
      await producer.disconnect()
    } catch (err) {
      logger.error(
        `Error while sending finding ${finding["id"]
        } to Eventstream : ${err}`
      );
      throw err;
    }
  }
  try {
    await runProducer()
    logger.info(`Finding ${finding["id"]} is published to '${topic}'`);
  } catch (err) {
    logger.error(
      `Error while sending finding ${finding["id"]
      } to Eventstream : ${err}`
    );
    throw err;
  }
}

async function createGitHubIssue(finding, params) {
  try {
    var issueDesc = `**Source**: ${finding["payload"]["reported_by"]["title"]}\n`;
    issueDesc = issueDesc + `**Finding**: ${finding["id"]}\n`;
    issueDesc = issueDesc + `**Severity**: ${finding["severity"]}\n`;
    issueDesc = issueDesc + `[View in Security Advisor Dashboard](${finding["issuer-url"]})\n`;
    var body = {
      title: `${finding["severity"]
        } severity finding reported by IBM Security Advisor`,
      body: issueDesc,
      labels: ["IBM Security Advisor"]
    };

    const config = {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `token ${params.GITHUB_ACCESS_TOKEN}`
      }
    };

    const response = await axios.post(params.GITHUB_API_URL, body, config);
  } catch (err) {
    logger.error(
      `Error while creating GitHub issue for finding ${finding["id"]
      }: ${JSON.stringify(err)}`
    );
    throw err;
  }
}

async function sendToSlack(finding, params) {
  try {
    const link = finding["issuer-url"];
    var messageDesc = `Source: ${finding["payload"]["reported_by"]["title"]}\n`;
    messageDesc = messageDesc + `Finding: ${finding["id"]}\n`;
    messageDesc = messageDesc + `Severity: ${finding["severity"]}\n`;
    var message = {
      channel: params.slackChannel,
      attachments: [
        {
          color: "#FFD300",
          text: "```" + messageDesc + "```",
          mrkdwn_in: ["text"],
          actions: [
            {
              type: "button",
              text: "View in Dashboard",
              url: link
            }
          ]
        }
      ],
      username: "IBM Security Advisor"
    };

    const config = {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    };

    const response = await axios.post(params.slackEndpoint, message, config);
  } catch (err) {
    logger.error(
      `Error while sending finding ${finding["id"]} to Slack : ${JSON.stringify(
        err
      )}`
    );
    throw err;
  }
}

/**
 *
 * main() will be run when you invoke this action
 *
 * @param params main Functions actions accept a single parameter, which must be a JSON object.
 * sample: {"data": "encryptedPayload"}
 *
 * @return The output of this action, which must be a JSON object.
 *
 */

async function main(params) {
  var decodedData = {};
  var publicKey, accessToken;
  var body = params;

  try {
    accessToken = await obtainAccessToken(params.iamTokenURL, params.apiKey);
  } catch (err) {
    logger.error(
      `Error occurred while getting access token : ${JSON.stringify(err)}`
    );
    return webhookInternalErrorResponse;
  }

  try {
    publicKey = await downloadPublicKey(accessToken, params.accountId, params);
  } catch (err) {
    logger.error(
      `Error occurred while downloading public key : ${JSON.stringify(err)}`
    );
    return webhookInternalErrorResponse;
  }

  try {
    decodedData = jwt.verify(body.data, publicKey, { algorithms: ["RS256"] });
  } catch (err) {
    logger.error(`JWT error : err`);
    return { err: `Error occurred decoding the alert ${err}` };
  }

  const finding = decodedData["security-advisor-alerts"][0];
  const severity = finding["severity"].toLowerCase();

  if (severity === "low") {
    try {
      logger.info(
        `Received a low severity finding ${finding["id"]}. Sending to Slack.`
      );
      await sendToSlack(finding, params);
    } catch (err) {
      logger.error(`Slack error : ${JSON.stringify(err)}`);
      return { err: "Couldn't notify slack" };
    }
  } else if (severity === "high" || severity === "medium") {
    try {
      logger.info(
        `Received a ${finding["severity"]} severity finding ${
          finding["id"]
        }. Creating a GitHub issue for the same.`
      );
      await createGitHubIssue(finding, params);
    } catch (err) {
      logger.error(`Github error : ${JSON.stringify(err)}`);
      return { err: "Couldn't create github issue" };
    }
  }

  if (params.sendToLogDNA === "True") {
    try {
      logger.info(
        `Received a finding ${finding["id"]}. Sending to logDNA.`
      );
      await sendToLogDNA(finding, params);
      logger.info(
        `Successfully send finding ${finding["id"]} to logDNA.`
      );
    } catch (err) {
      logger.error(`logDNA error : ${err}`);
      return { err: "Couldn't send to logDNA" };
    }
  }

  if (params.sendToEventstream === "True") {
    try {
      logger.info(
        `Received a finding ${finding["id"]}. Sending to Event stream.`
      );
      await sendToEventstream(finding, params);
      logger.info(
          `Successfully send finding ${finding["id"]} to Event stream.`
      );
    } catch (err) {
      logger.error(`Eventstream error : ${err}`);
      return { err: "Couldn't send to Eventstream" };
    }
  }
}

exports.main = main;
