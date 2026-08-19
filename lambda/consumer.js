// Subscribed to EventBridge. Receives an OrderPlaced/OrderUpdated domain event
// and writes the denormalized row into the projection table.
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const client = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

exports.handler = async (event) => {
  // EventBridge delivers the event; the domain payload is in event.detail
  const order = event.detail;
  console.log(JSON.stringify({ event: 'projecting', orderId: order.orderId }));

  await client.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      orderId:  { S: order.orderId },
      status:   { S: order.status ?? 'PLACED' },
      customer: { S: order.customer ?? 'unknown' },
    },
  }));

  return { statusCode: 200 };
};
