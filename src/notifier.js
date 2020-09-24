const jwt = require("jsonwebtoken");
const axios = require("axios");
var log4js = require("log4js");
const date = require('date-and-time');
var logger = log4js.getLogger('security-advisor-notification-webhook');
logger.level = "info";
const request = require("request");
const path = require('path');

const webhookInternalErrorResponse = { err: "WebHook Internal Error." };

const DEFAULTS = {
  POLL_INTERVAL: 100
};
const producerOptsDefaults = DEFAULTS;
const MEGA = 1e6;  // === the default max message size of kafka

class Producer {

    /**
     * Constructor for Producer
     * @param {Function} readiness a function that will be called in case of ready state change, optional
     * @param {Object} logger the logger Producer should use, optional. If not supplied a default logger is used.
     * @param {Object} Kafka the kafka client lib that will be used.
     *
     */
    constructor(readiness,
                logger = require("log4js").getLogger('Producer'),
                Kafka = require('node-rdkafka')) {

        this.logger = logger;
        this.readiness = readiness;
        this.ready = false;

        this.middlewares = [];
        this.messageMaxLengthInBytes = null;  // set in init

        this.validateKafkaProducerConfig = () => {
            return (this.kafkaProducerConfig && this.kafkaProducerConfig['metadata.broker.list'] !== undefined)
        };

        this.connectKafka = (resolve, reject) => {
            if(!this.kafkaProducer) return reject(`${Producer.ERRORS.CONNECT_ERROR}. Reason is: Producer not initialized.`);
            if(this.kafkaProducer.isConnected()) return resolve();
            this.kafkaProducer.connect({},(err, data) => {
                if(err) {
                    return reject(`${Producer.ERRORS.CONNECT_ERROR}. Reason is: ${err}. ${data ? JSON.stringify(data): ''}.`);
                }
                this.logger.info(`Producer connected`);
                this.topics = data.topics.map(t=>t.name);
                return resolve(data);
            });
        };

        this.disconnectKafka = (resolve, reject) => {
            if(!this.kafkaProducer) return reject(`${Producer.ERRORS.DISCONNECT_ERROR}. Reason is: Producer not initialized.`);
            if(this.kafkaProducer) {
                try {
                    this.kafkaProducer.disconnect((nop, data)=>{
                        resolve(data);
                    });
                } catch (err) {
                    return reject(`${Producer.ERRORS.DISCONNECT_ERROR}. Reason is: ${err}.`);
                }
            }
        };

        /**
         * Init Producer
         * @param {Object} kafkaProducerConfig the configuration for Kafka producer, required. Refer to kafkaProducerConfig doc.
         * @param {Object} kafkaTopicConfig the configuration for Kafka topic, optional. Refer to kafkaOptionConfig doc.
         * @param {Object} producerOpts the options for data-producer, optional. Refer to producerOpts doc.
         */
        this.init = (kafkaProducerConfig, kafkaTopicConfig, producerOpts) => {
            return new Promise((resolve, reject) => {
                this.logger.info(`Initializing producer.`);
                this.kafkaProducerConfig = kafkaProducerConfig;
                this.kafkaTopicConfig = kafkaTopicConfig;
                this.producerOpts = producerOpts;

                if(!this.validateKafkaProducerConfig()) {
                    return reject(`${Producer.ERRORS.INIT_ERROR_MISSING_CONFIG}. Reason is: Missing Kafka producer configuration.`);
                }

                //Create the kafka producer
                try {
                    this.kafkaProducer = new Kafka.Producer(this.kafkaProducerConfig, this.kafkaTopicConfig);
                } catch (err) {
                    return reject(`${Producer.ERRORS.INIT_ERROR_KAFKA_PRODUCER}. Reason is: ${err}.`);
                }

                this.messageMaxLengthInBytes = this.kafkaProducerConfig['message.max.bytes'] || MEGA;
                this.logger.info(`Producer: Message max length in bytes is ${this.messageMaxLengthInBytes}. This parameter is used by chunker.`);

                // Polls the producer, handling disconnections and reconnection
                const pollInterval = (this.producerOpts && this.producerOpts.pollInterval) ? this.producerOpts.pollInterval : producerOptsDefaults.POLL_INTERVAL;
                this.kafkaProducer.setPollInterval(pollInterval);

                const self = this;
                // Log delivery-report event in case: 'dr_cb': true
                this.kafkaProducer.on('delivery-report', function(err, report) {
                    if(err){
                        self.logger.error(`Kafka acknowledge error delivery-report: '${err}'`);
                    } else {
                        self.logger.debug(`Kafka acknowledge delivery-report: '${JSON.stringify(report)}'`);
                    }
                });

                //Listen for ready event
                this.kafkaProducer.on('ready', function(arg) {
                    self.logger.info(`Producer is ready: '${JSON.stringify(arg)}'`);
                    self.ready = true;
                    if(self.readiness) self.readiness(true);
                });

                //logging debug messages, if debug is enabled
                this.kafkaProducer.on('event.log', function(log) {
                    self.logger.debug(`Kafka Producer log: '${JSON.stringify(log)}'`);
                });

                //logging all errors
                this.kafkaProducer.on('event.error', function(err) {
                    self.logger.debug(`Kafka Producer err: '${err}'`); // Setting to debug to clear-out numerous false-positive prints to prod log
                });

                this.kafkaProducer.on('disconnected', function(arg) {
                    self.logger.info(`Producer disconnected: '${JSON.stringify(arg)}'`);
                    self.ready = false;
                    if(self.readiness) self.readiness(false);
                });

                //Connecting the producer
                this.logger.debug(`Connecting the producer`);
                return this.connectKafka(resolve, reject);
            });
        };

        /*
        Adds a middleware. The middlewares are applied in the produce method in the order that they were added.
        A middleware should be a callback which receives a Buffer (message), maxMessageLength and more the optionals:
        topic, partition, buf, key, timestamp, opaque
        and should return a Buffer or an array of Buffers
        */
        this.use = (middleware) => {
            this.logger.debug(`Producer uses middleware ${middleware}`);
            this.middlewares.push(middleware)};

        this.cleanMiddlewares = () => {
            this.logger.debug(`Producer middlewares were removed`);
            this.middlewares = [];};
    }

    hasTopic(topic) {
        return this.topics.includes(topic);
    }

    isReady() {
        return this.ready;
    }

    connect() {
        return new Promise((resolve, reject) => {
            return this.connectKafka(resolve, reject);
        });
    }

    disconnect() {
        return new Promise((resolve, reject) => {
            return this.disconnectKafka(resolve, reject);
        });
    }

    handleError(e) {
        this.logger.error(e);
    }

    /**
     * Produce a message to Kafka synchronously.
     *
     * This is the method mainly used in this class. Use it to produce a message to Kafka.
     * When this is sent off, there is no guarantee it is delivered. If you need
     * guaranteed delivery, change your *acks* settings, or use delivery reports.
     *
     * @param {string} topic - The topic name to produce to.
     * @param {number|null} partition - The partition number to produce to, default is -1.
     * @param {Buffer|null} message - The message to produce.
     * @param {string} key - The key associated with the message.
     * @param {number|null} timestamp - Timestamp to send with the message.
     * @param {object} opaque - An object you want passed along with this message, if provided.
     * @throws {Error} - Throws a an error if it failed.
     * @return {boolean} - returns an error if it failed, or true if not
     * @see node-rdkafka.Producer#produce
     */
    produce(topic, partition=-1, message, key, timestamp, opaque) {
        if(!topic) throw new Error(Producer.ERRORS.PRODUCE_ERROR_MISSING_TOPIC);
        try {
            this.logger.debug(`Produce message to topic '${JSON.stringify(topic)}' without middleware`);
            return this.kafkaProducer.produce(topic, partition, message, key, timestamp, opaque);
        } catch (err) {
            throw new Error(`${Producer.ERRORS.PRODUCE_ERROR} topic '${JSON.stringify(topic)}'. Reason is: ${err}`);
        }
    };
}

Producer.ERRORS = {
    INIT_ERROR_KAFKA_PRODUCER: `Couldn't init producer`,
    INIT_ERROR_MISSING_CONFIG: `Couldn't init producer. Reason is: Missing configuration`,
    INIT_ERROR_DELIVERY_REPORT: `Kafka acknowledge error delivery-report`,
    PRODUCE_ERROR_MISSING_TOPIC: 'Missing topic',
    CONNECT_ERROR: `Couldn't connect to Kafka`,
    DISCONNECT_ERROR: `Couldn't disconnect from Kafka`,
    PRODUCE_ERROR: `Couldn't produce message to Kafka`,
    PRODUCE_ERROR_MIDDLEWARE_FAILURE: `Middleware application failed`,
};

async function getproducerOpts() {
  /**
   * Data producer options
   * @param {Object} producerOpts the options data-producer should use, optional.
   * @param {number} producerOpts['pollInterval'] Poll producer interval [ms], handling disconnections and reconnection [ms], optional. Default 100[ms].
   */


  const config = {
    'pollInterval': DEFAULTS.POLL_INTERVAL
  };

  config.DEFAULTS = DEFAULTS;

  return config;
}

async function getkafkaTopicConfig() {
  /**
   * Kafka topic configuration properties
   *
   * For full description refer to https://github.com/edenhill/librdkafka/blob/0.11.1.x/CONFIGURATION.md#topic-configuration-properties
   *
   * @param {Object} kafkaTopicConfig the configuration data-producer should use for Kafka topic configuration, optional.
   * @param {number} kafkaTopicConfig['request.required.acks'] This value controls when a produce request is considered completed.
   * Specifically, how many other brokers must have committed the data to their log and acknowledged this to the leader?
   * Typical values are:
   *   0, which means that the producer never waits for an acknowledgement from the broker.
   *      This option provides the lowest latency but the weakest durability guarantees (some data will be lost when a server fails).
   *   1, which means that the producer gets an acknowledgement after the leader replica has received the data.
   *      This option provides better durability as the client waits until the server acknowledges the request as successful
   *      (only messages that were written to the now-dead leader but not yet replicated will be lost).
   *  -1, which means that the producer gets an acknowledgement after all in-sync replicas have received the data.
   *      This option provides the best durability, we guarantee that no messages will be lost as long as at least one in sync replica remains.
   * Param is optional. Default 0.
   * @param {number} kafkaTopicConfig['request.timeout.ms'] The ack timeout of the producer request in milliseconds.
   * This value is only enforced by the broker and relies on request.required.acks being != 0.
   * Param is optional. Default 5000[ms].
   * @param {number} kafkaTopicConfig['message.timeout.ms'] Local message timeout.
   * This value is only enforced locally and limits the time a produced message waits for successful delivery. A time of 0 is infinite.
   * Param is optional. Default 300000[ms].
   *
   */

  const DEFAULTS = {
    REQUEST_REQUIRED_ACKS: 0,
    REQUEST_TIMEOUT_MS: 5000,
    MESSAGE_TIMEOUT_MS: 300000
  };

  const config = {
    'request.required.acks': DEFAULTS.REQUEST_REQUIRED_ACKS,
    'request.timeout.ms': DEFAULTS.REQUEST_TIMEOUT_MS,
    'message.timeout.ms': DEFAULTS.MESSAGE_TIMEOUT_MS,
  };

  return config
}

async function getkafkaProducerConfig() {
  /**
   * Kafka producer configuration properties
   *
   * For full description refer to https://github.com/edenhill/librdkafka/blob/0.11.1.x/CONFIGURATION.md
   * @param {Object} kafkaProducerConfig the configuration data-producer should use for Kafka producer configuration, required.
   * @param {String} kafkaProducerConfig['metadata.broker.list'] comma separated list of Kafka brokers the Producer should use, required.
   * @param {String} kafkaProducerConfig['security.protocol'] Protocol used to communicate with brokers, optional. Default is plaintext.
   * @param {String} kafkaProducerConfig['sasl.mechanisms'] SASL mechanism to use for authentication, optional. Default is sasl_ssl.
   * @param {String} kafkaProducerConfig['sasl.username'] SASL username for use with the PLAIN and SASL-SCRAM mechanisms, required.
   * @param {String} kafkaProducerConfig['sasl.password'] SASL password for use with the PLAIN and SASL-SCRAM mechanisms, required.
   * @param {String} kafkaProducerConfig['ssl.ca.location'] File or directory path to CA certificate(s) for verifying the broker's key, optional.
   * @param {boolean} kafkaProducerConfig['socket.keepalive.enable'] Enable TCP keep-alives (SO_KEEPALIVE) on broker sockets, optional. Default is true.
   * @param {number} kafkaProducerConfig['message.send.max.retries'] How many times to retry sending a failing MessageSet. Note: retrying may cause reordering. Param is optional. Default 2.
   * @param {number} kafkaProducerConfig['retry.backoff.ms'] The backoff time in milliseconds before retrying a message send. Param is optional. Default 100[ms].
   * @param {boolean} kafkaProducerConfig['api.version.request'] Request broker's supported API versions to adjust functionality to available protocol features. If set to false, or the ApiVersionRequest fails, the fallback version broker.version.fallback will be used. NOTE: Depends on broker version >=0.10.0. If the request is not supported by (an older) broker the broker.version.fallback fallback is used, optional. Default is true.
   * @param {String} kafkaProducerConfig['broker.version.fallback'] Older broker versions (<0.10.0) provides no way for a client to query for supported protocol features (ApiVersionRequest, see api.version.request) making it impossible for the client to know what features it may use. As a workaround a user may set this property to the expected broker version and the client will automatically adjust its feature set accordingly if the ApiVersionRequest fails (or is disabled). The fallback broker version will be used for api.version.fallback.ms. Valid values are: 0.9.0, 0.8.2, 0.8.1, 0.8.0. Any other value, such as 0.10.2.1, enables ApiVersionRequests, optional. Default is 0.9.0.
   * @param {boolean} kafkaProducerConfig['dr_cb'] Delivery report callback, optional. Default is false.
   *
   */

  console.log("getkafkaProducerConfig")
  const DEFAULTS = {
    SECURITY_PROTOCOL: 'sasl_ssl',
    SASL_MECHANISM: 'PLAIN',
    API_VERSION_REQUEST: true,
    BROKER_VERSION_FALLBACK: '0.10.2.1',
    DR_CB: false,
    MESSAGE_SEND_MAX_RETRIES: 2,
    RETRY_BACKOFF_MS: 100,
    SOCKET_KEEPALIVE_ENABLE: true
  };

  const config = {
    'security.protocol':  DEFAULTS.SECURITY_PROTOCOL,
    'sasl.mechanisms': DEFAULTS.SASL_MECHANISM,
    'api.version.request': DEFAULTS.API_VERSION_REQUEST,
    'broker.version.fallback': DEFAULTS.BROKER_VERSION_FALLBACK,
    'dr_cb': DEFAULTS.DR_CB,
    'message.send.max.retries': DEFAULTS.MESSAGE_SEND_MAX_RETRIES,
    'retry.backoff.ms': DEFAULTS.RETRY_BACKOFF_MS,
    'socket.keepalive.enable': DEFAULTS.SOCKET_KEEPALIVE_ENABLE
  };
  config['debug'] = 'all';

  console.log("getkafkaProducerConfig config: " + config)

  return config;
}



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

async function createAndInitProducer(params) {
  console.log("createAndInitProducer")
  const producer = new Producer();

  const kafkaProducerConfig = await getkafkaProducerConfig();

  console.log("kafkaProducerConfig:" + kafkaProducerConfig)
  let config = JSON.parse(JSON.stringify(kafkaProducerConfig));
  config["metadata.broker.list"] = params.kafkaMetadataBrokerList;
  config["sasl.username"] = params.kafkaSaslUsername;
  config["sasl.password"] = params.kafkaSaslPassword;
  console.log("config:" + config)
  try {
    const kafkaTopicConfig = await getkafkaTopicConfig();
    const producerOpts = await getproducerOpts();

    console.log("producerOpts", producerOpts)
    console.log("kafkaTopicConfig", kafkaTopicConfig)

    await producer.init(config, kafkaTopicConfig, producerOpts);
  } catch (err) {
    logger.error(
      `Error initializing producer. Error ${err}`
    );
    throw err;
  }
  logger.info(`Producer initialized`);
  return producer
};

async function sendToEventstream(finding, params) {
  console.log("sendToEventstream")
  try {
    const producer = await createAndInitProducer(params);

    const message = Buffer.from(JSON.stringify(finding));
    const topic = params.kafkaTopic;
    try {
      if (producer.produce(topic, -1, message)) {
        logger.info(`Finding ${finding["id"]} is published to '${topic}'`);
      } else {
        logger.error(`Publishing to '${topic}' failed`);
        throw Error(`Couldn't publish to topic  ${topic}`);
      }
    } catch (err) {
      logger.error(
        `Request to publish to '${topic}' failed. Reason is: '${err.message}'.`
      );
      throw err;
    }
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

exports.main = main;
