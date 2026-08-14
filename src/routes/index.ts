import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes';
import { executionRouter } from '../modules/executions/execution.routes';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/executions', executionRouter);
