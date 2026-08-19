import { Amplify } from 'aws-amplify';
import { APPSYNC_URL, REGION, USER_POOL_ID, USER_POOL_CLIENT_ID } from './config';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: USER_POOL_ID,
      userPoolClientId: USER_POOL_CLIENT_ID,
      loginWith: { email: true },
    },
  },
  API: {
    GraphQL: {
      endpoint: APPSYNC_URL,
      region: REGION,
      defaultAuthMode: 'userPool',   // browser now authenticates as the logged-in user
    },
  },
});