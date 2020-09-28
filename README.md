# Security Advisor Notification Receiver

In this repo we will be making use of [Cloud Function](https://cloud.ibm.com/docs/openwhisk/index.html#index) to create a notification receiver for Security Advisor Notification service.

## The above code contains five functions:
**obtainAccessToken**:
Access token is required to call the Security Advisor notifications API. We use the IAM token 
endpoint to get the access token for any IBM Cloud account. You need to provide a platform api key 
from your IBM Cloud account for the same.

**downloadPublicKey**:
Security Advisor notifications are sent as a signed JSON web token (JWT). This allows us to verify that the notification payload was actually sent by our Security Advisor and wasn’t tampered with. In order to verify the signature, we must first get the notifications public key from Security Advisor. We used the Security Advisor Notification API to request the notifications public key for our instance. We specified the key format as pem since that is what the jsonwebtoken package supports. You need to update url property in this function with your values.

**createGitHubIssue**:
If the finding received as part of notification signifies MEDIUM/HIGH severity, then this particular function will be called to create a git hub issue. This function builds issue description and creates an issue in the Git Hub url provided. Before we begin creating GitHub issue, we’ll need to create a repo to send the issues to (or use an existing one) and create a personal GitHub access token. To create the access token, go to https://github.com/settings/tokens and generate a new personal access token. For more information about creating GitHub issues, see this [link](https://developer.github.com/v3/issues/#create-an-issue)

**sendToSlack**: 
If the finding received as part of notification signifies LOW severity, then this particular function will be called to send a Slack alert. This function builds message with necessary information (example: findings id, source etc) and post it to given Slack channel. Before we begin sent Slack alert, we will need a slack channel and a webhook url for the same. For more information, see this [link](https://api.slack.com/incoming-webhooks#create_a_webhook)

**sendToEventstream**:
All the findings that are received as part of this notification webhook will be put into a configured event stream (kafka) topic. This function will act as kafka producer.

**sendToLogDNA**:
All the findings that are received as part of this notification webhook will be send to a configured logDNA instance.

**main**:
IBM Cloud Functions requires a function called main to exist as an entry point for the action. The params object contains the body of the incoming request. Security Advisor notification body contains a single JSON object with a single property called **data** that holds the signed JWT string as its value.
When we obtained the public key, we can use it to verify the JWT signature. We’ll use the jsonwebtoken library’s verify function. This function receives the JWT string and a public key and returns the payload decoded if the signature is valid. If not, it will throw an error.

## Pre-requisites
1. Download and install `ibmcloud cli` from https://github.com/IBM-Cloud/ibm-cloud-cli-release/releases
2. Install Cloud Functions plug-in `ibmcloud plugin install cloud-functions`. More details can be found [here](https://cloud.ibm.com/openwhisk/learn/cli)
3. Target a namespace for your Cloud Function.     
   - `ibmcloud login`
   - `ibmcloud target --cf`
   - `ibmcloud fn property set --namespace <namespace_name>`

## Create Cloud function action using CLI

1. Clone the repo : `git clone git@github.com:ibm-cloud-security/security-advisor-notification-webhook.git`
2. `cd security-advisor-notification-webhook`
3. Install all dependencies locally. `npm install`
4. Build the webpack bundle. `npm run build`
5. Create the action. `npm run deploy`
6. Update `params.json` file  with proper values.       
   - **apiKey** : Provide apikey for your account with Manager access to security advisor service
   - **iamTokenURL** : IAM token endpoint
   - **notificationChannelUrl** : Notification API endpoint, `<region>` values must be us-south or eu-gb
   - **accountId** : Provide IBM Cloud account id
   - **slackEndpoint** : Slack webhook url
   - **slackChannel** : Slack channel name
   - **GITHUB_ACCESS_TOKEN** : Developer access token generated using GitHub
   - **GITHUB_API_URL** : GitHub API url for your repo
   - **sendTologDNA** : True/False, If set to True will send the finding to configured logDNA instance.
   - **logDNAEndpoint** : logDNA ingestion endpoint, example: https://logs.us-south.logging.cloud.ibm.com
   - **logDNAIngestionKey** : logDNA ingestion key from logDNA instance UI.
   - **sendToEventstream** : True/False, If set to True will send the finding to configured Eventstream instance.
   - **kafkaMetadataBrokerList** : Kafka metadata broker list from Event stream instance service credentials.
   - **kafkaSaslUsername** : Kafka user name from Event stream instance service credentials
   - **kafkaSaslPassword** : kafka user password from Event stream instance service credentials
   - **kafkaTopic** : Kafka topic name

7. Bind parameters to your action.   
   - `ibmcloud fn action update security-advisor-notifier --param-file params.json`
   - Verify using `ibmcloud fn action get security-advisor-notifier parameters`
8. Get the URL endpoint for your action.
   - ```echo `ibmcloud fn action get security-advisor-notifier --url | grep 'https'`'.json'```
