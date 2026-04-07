import type { Action, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { OnboardingService, type OnboardingTurn } from '../services/onboarding-service.js';
import * as migrations from '../db/migrations.js';

const TOTAL_QUESTIONS = 6;

const FIRST_QUESTION =
  "What's the most you'd be comfortable losing in a bad month — the number where you'd say 'okay, that's what I signed up for'?";

type QuestionAnswerPair = {
  question: string;
  answer: string | null;
};

function getQuestionAnswerPairs(history: OnboardingTurn[]): QuestionAnswerPair[] {
  const pairs: QuestionAnswerPair[] = [];

  for (const turn of history) {
    if (turn.phase !== 'questions') continue;

    if (turn.role === 'agent') {
      pairs.push({ question: turn.content, answer: null });
      continue;
    }

    const currentPair = pairs[pairs.length - 1];
    if (currentPair) {
      currentPair.answer = turn.content;
    }
  }

  return pairs;
}

function buildCanonicalQuestionHistory(history: OnboardingTurn[]): string {
  return getQuestionAnswerPairs(history)
    .map((pair, i) => `Q${i + 1}: ${pair.question}\nA${i + 1}: ${pair.answer ?? '[no answer yet]'}`)
    .join('\n\n');
}

function buildCanonicalConversation(history: OnboardingTurn[]): string {
  return getQuestionAnswerPairs(history)
    .flatMap(pair => [
      `Nostra: ${pair.question}`,
      ...(pair.answer === null ? [] : [`User: ${pair.answer}`]),
    ])
    .join('\n');
}

function buildContradictionPrompt(history: OnboardingTurn[]): string {
  const qaText = buildCanonicalQuestionHistory(history);

  return `You are reviewing a user's financial beliefs for contradictions.

Conversation so far:
${qaText}

Does the most recent user answer contradict any of their earlier answers?

Rules:
- If YES: respond with EXACTLY "CONTRADICTION: You said [exact previous belief] earlier, but [new answer] implies [contradiction]. Want to revise either one?"
- If NO: respond with exactly "OK"
- Respond with ONLY one of those two formats — no other text.`;
}

function buildQuestionPrompt(history: OnboardingTurn[], questionNumber: number, total: number): string {
  const historyText = buildCanonicalConversation(history);

  return `You are Nostra — a constitutional financial agent helping a user co-author their First Constitution.

You are conducting a Socratic interview to understand the user's financial beliefs.

Rules for your response:
1. Ask EXACTLY ONE question — never two questions in one message
2. Use plain, conversational English — no financial jargon
3. The question must reveal a belief relevant to governing a DeFi treasury
4. Build naturally on what the user has already said
5. Do not repeat a question already asked

Conversation so far:
${historyText}

This is question ${questionNumber} of ${total}. Ask one Socratic question:`;
}

function buildSummaryPrompt(history: OnboardingTurn[]): string {
  const qaText = buildCanonicalConversation(history);

  return `You are Nostra. A user has completed a Socratic interview about their financial beliefs.

Full conversation:
${qaText}

Write a summary of their beliefs that will become their First Constitution.

Requirements:
- Format: start with "Based on our conversation, here are the financial beliefs you've expressed:"
- List 5–7 beliefs as bullet points (•) in the user's own words
- Each belief is one concise sentence
- End with: "Do these accurately reflect what you believe? Tell me what you'd like to change, or say yes to proceed and I'll write your constitution."
- Tone: warm, authorial — make the user feel ownership of these rules
- Length: 200–300 words (ceremonially weighted — UX-DR9)`;
}

function buildApprovalCheckPrompt(userText: string, history: OnboardingTurn[]): string {
  const summaryTurn = [...history].reverse().find(t => t.role === 'agent' && t.phase === 'summary');
  return `The agent just presented a belief summary to the user. The user responded.

Agent's summary:
${summaryTurn?.content ?? '[summary not found]'}

User's response: "${userText}"

Is the user approving the summary (saying yes, looks good, proceed, that's right, correct, etc.) or requesting changes?

Respond with EXACTLY "APPROVED" or "REVISION" — no other text.`;
}

function buildRevisionSummaryPrompt(history: OnboardingTurn[], userRevisionRequest: string): string {
  const summaryTurn = [...history].reverse().find(t => t.role === 'agent' && t.phase === 'summary');
  const qaText = history
    .filter(t => t.phase === 'questions')
    .map(t => `${t.role === 'agent' ? 'Nostra' : 'User'}: ${t.content}`)
    .join('\n');

  return `You are Nostra. You presented a belief summary to the user and they want to revise it.

Original conversation:
${qaText}

The summary you presented:
${summaryTurn?.content ?? '[summary]'}

User's revision request: "${userRevisionRequest}"

Rewrite the summary incorporating their requested change. Keep the same format:
- Start with "Based on our conversation, here are the financial beliefs you've expressed:"
- Bullet points (•), 5–7 beliefs in their own words
- End with "Do these accurately reflect what you believe? Tell me what you'd like to change, or say yes to proceed."
- Length: 200–300 words`;
}

async function handleSummaryResponse(
  runtime: IAgentRuntime,
  _message: Memory,
  db: ReturnType<typeof migrations.getDb>,
  userText: string,
  callback: HandlerCallback | undefined,
  history: OnboardingTurn[],
): Promise<void> {
  if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });

  const approvalPrompt = buildApprovalCheckPrompt(userText, history);
  const approvalResult = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: approvalPrompt,
    temperature: 0.2,
    maxTokens: 50,
  });

  if (approvalResult.trim().toUpperCase().startsWith('APPROVED')) {
    const confirmationMsg = `Perfect. Your beliefs are clear.\n\nLet me write your First Constitution now. ⏳ Thinking...`;
    if (callback) await callback({ text: confirmationMsg, actions: [], source: 'nostra' });
    OnboardingService.addTurn(db, 'user', userText, 'summary');
    await AgentStateService.setState({ onboardingState: 'beliefs_confirmed' }, db);
  } else {
    OnboardingService.addTurn(db, 'user', userText, 'summary');
    if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });
    const revisionPrompt = buildRevisionSummaryPrompt(history, userText);
    const revisedSummary = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: revisionPrompt,
      temperature: 0.6,
      maxTokens: 600,
    });
    if (callback) await callback({ text: revisedSummary, actions: [], source: 'nostra' });
    OnboardingService.addTurn(db, 'agent', revisedSummary, 'summary');
  }
}

export const SocraticOnboardingAction: Action = {
  name: 'SOCRATIC_ONBOARDING',
  similes: ['ONBOARDING', 'CONSTITUTION_INTERVIEW'],
  description: 'Drives the Socratic onboarding interview to capture the user\'s financial beliefs.',

  validate: async (_runtime, message) => {
    try {
      const text = (message.content?.text ?? '').trim();
      if (text.startsWith('/')) return false;
      const state = AgentStateService.getState();
      return (
        state.onboardingState === 'disclaimer_delivered' ||
        state.onboardingState === 'socratic_in_progress'
      );
    } catch {
      return false;
    }
  },

  handler: async (runtime, message, _state, _options, callback) => {
    const db = migrations.getDb();
    const agentState = AgentStateService.getState();
    const userText = (message.content?.text ?? '').trim();

    // Step A: Transition state from disclaimer_delivered to socratic_in_progress
    if (agentState.onboardingState === 'disclaimer_delivered') {
      await AgentStateService.setState({ onboardingState: 'socratic_in_progress' }, db);
    }

  const history = OnboardingService.getHistory(db);
  const lastTurn = history[history.length - 1] ?? null;

    // ─── SUMMARY PHASE ────────────────────────────────────────────────────────
    if (lastTurn?.role === 'agent' && lastTurn?.phase === 'summary') {
      await handleSummaryResponse(runtime, message, db, userText, callback, history);
      return;
    }

    // ─── RECORD USER ANSWER ───────────────────────────────────────────────────
    // When lastTurn is null the DB is empty — this is the acknowledgment after the
    // disclaimer. Do NOT record it so updatedUserCount stays 0 and FIRST_QUESTION
    // (questionNumber===1) is sent with no LLM call (anti-pattern: no useModel for Q1).
    // When lastTurn is 'agent' the user is answering that question.
    // When lastTurn is 'user' a contradiction was surfaced and this is a revision.
    if (lastTurn !== null) {
      OnboardingService.addTurn(db, 'user', userText, 'questions');
    }

    // Re-fetch updated history and counts after recording
    const updatedHistory = OnboardingService.getHistory(db);
    const answeredQuestionCount = getQuestionAnswerPairs(updatedHistory).filter(pair => pair.answer !== null).length;

    // ─── CONTRADICTION CHECK ──────────────────────────────────────────────────
    if (answeredQuestionCount > 1) {
      if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });
      const contradictionPrompt = buildContradictionPrompt(updatedHistory);
      const contradictionResult = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: contradictionPrompt,
        temperature: 0.3,
        maxTokens: 200,
      });
      if (contradictionResult.trim().toUpperCase().startsWith('CONTRADICTION:')) {
        const contradictionMessage = contradictionResult.trim().replace(/^CONTRADICTION:\s*/i, '').trim();
        if (callback) await callback({ text: contradictionMessage, actions: [], source: 'nostra' });
        OnboardingService.addTurn(db, 'agent', contradictionMessage, 'contradiction');
        return;
      }
    }

    // ─── NEXT QUESTION OR SUMMARY ─────────────────────────────────────────────
    const questionNumber = answeredQuestionCount + 1;

    if (answeredQuestionCount >= TOTAL_QUESTIONS) {
      if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });
      const summaryPrompt = buildSummaryPrompt(updatedHistory);
      const summaryText = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: summaryPrompt,
        temperature: 0.6,
        maxTokens: 600,
      });
      if (callback) await callback({ text: summaryText, actions: [], source: 'nostra' });
      OnboardingService.addTurn(db, 'agent', summaryText, 'summary');
    } else {
      let questionText: string;
      if (questionNumber === 1) {
        questionText = FIRST_QUESTION;
      } else {
        if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });
        const questionPrompt = buildQuestionPrompt(updatedHistory, questionNumber, TOTAL_QUESTIONS);
        questionText = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: questionPrompt,
          temperature: 0.7,
          maxTokens: 150,
        });
        questionText = questionText.trim();
      }
      if (callback) await callback({ text: questionText, actions: [], source: 'nostra' });
      OnboardingService.addTurn(db, 'agent', questionText, 'questions');
    }
  },

  examples: [],
};
