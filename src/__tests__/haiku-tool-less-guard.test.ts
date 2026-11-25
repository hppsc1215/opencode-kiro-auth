import { describe, expect, test } from 'bun:test'
import { ResponseHandler } from '../core/request/response-handler.js'
import {
  buildPlaceholderToolSpec,
  KIRO_PLACEHOLDER_TOOL_NAME
} from '../infrastructure/transformers/tool-less-refusal.js'
import { transformToSdkRequest } from '../plugin/request.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'
import { transformKiroStream } from '../plugin/streaming/stream-transformer.js'

const HAIKU = 'claude-haiku-5-5'
const HAIKU_THINKING = 'claude-haiku-5-5-thinking'
const OTHER_MODEL = 'claude-sonnet-4-5'

const auth: any = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

const CLIENT_TOOL = {
  type: 'function',
  function: {
    name: 'search_docs',
    description: 'Look up documentation',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  }
}

function currentContext(prepared: any) {
  return prepared.conversationState.currentMessage.userInputMessage.userInputMessageContext
}

function request(messages: any[], tools?: any) {
  return tools === undefined ? { messages } : { messages, tools }
}

function sdkStreamOf(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

function rawStreamOf(events: any[]) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
        controller.close()
      }
    })
  )
}

async function collect(stream: AsyncGenerator<any>) {
  const chunks: any[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function toolNames(chunks: any[]) {
  return chunks.flatMap((chunk) =>
    (chunk.choices?.[0]?.delta?.tool_calls || []).map((call: any) => call.function?.name)
  )
}

describe('claude-haiku-5.5 tool-less refusal guard', () => {
  test('injects one inert placeholder tool when no tools are declared', () => {
    const prepared: any = transformToSdkRequest(
      request([{ role: 'user', content: '2+2=' }]),
      HAIKU,
      auth
    )

    const tools = currentContext(prepared).tools
    expect(tools).toEqual([buildPlaceholderToolSpec()])
    expect(prepared.placeholderToolName).toBe(KIRO_PLACEHOLDER_TOOL_NAME)
    expect(tools[0].toolSpecification.name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  })

  test('injects for the thinking alias and for an explicit empty tools array', () => {
    for (const model of [HAIKU_THINKING, 'claude-haiku-5.5', 'claude-haiku-5.5-thinking']) {
      const prepared: any = transformToSdkRequest(
        request([{ role: 'user', content: 'Name this conversation' }], []),
        model,
        auth
      )

      expect(currentContext(prepared).tools).toEqual([buildPlaceholderToolSpec()])
      expect(prepared.placeholderToolName).toBe(KIRO_PLACEHOLDER_TOOL_NAME)
    }
  })

  test('leaves requests with client tools untouched', () => {
    const prepared: any = transformToSdkRequest(
      request([{ role: 'user', content: 'Search the docs' }], [CLIENT_TOOL]),
      HAIKU,
      auth
    )

    const tools = currentContext(prepared).tools
    expect(tools).toHaveLength(1)
    expect(tools[0].toolSpecification.name).toBe('search_docs')
    expect(prepared.placeholderToolName).toBeUndefined()
  })

  test('leaves tool-less requests to other models untouched', () => {
    for (const model of [OTHER_MODEL, 'claude-haiku-4-5']) {
      const prepared: any = transformToSdkRequest(
        request([{ role: 'user', content: 'Hello' }]),
        model,
        auth
      )

      expect(currentContext(prepared)).toBeUndefined()
      expect(prepared.placeholderToolName).toBeUndefined()
    }
  })

  test('keeps replay tool specs instead of the placeholder when history carries tool calls', () => {
    const prepared: any = transformToSdkRequest(
      request([
        { role: 'user', content: 'Run the tool' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'search_docs', arguments: '{"query":"status"}' }
            }
          ]
        },
        { role: 'user', content: 'Continue' }
      ]),
      HAIKU,
      auth
    )

    const names = currentContext(prepared).tools.map((tool: any) => tool.toolSpecification.name)
    expect(names).toEqual(['search_docs'])
    expect(prepared.placeholderToolName).toBeUndefined()
  })

  test('drops a placeholder-only streaming call and finishes with end_turn', async () => {
    const chunks = await collect(
      transformSdkStream(
        sdkStreamOf([
          {
            toolUseEvent: {
              name: KIRO_PLACEHOLDER_TOOL_NAME,
              toolUseId: 'placeholder-1',
              input: '{}',
              stop: true
            }
          }
        ]),
        HAIKU,
        'conversation-1',
        undefined,
        KIRO_PLACEHOLDER_TOOL_NAME
      )
    )

    expect(toolNames(chunks)).toEqual([])
    const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason)
    expect(finish.choices[0].finish_reason).toBe('stop')
  })

  test('keeps a real streaming tool call next to a dropped placeholder call', async () => {
    const chunks = await collect(
      transformSdkStream(
        sdkStreamOf([
          {
            toolUseEvent: {
              name: KIRO_PLACEHOLDER_TOOL_NAME,
              toolUseId: 'placeholder-1',
              input: '{}',
              stop: true
            }
          },
          {
            toolUseEvent: {
              name: 'search_docs',
              toolUseId: 'call-1',
              input: '{"query":"status"}',
              stop: true
            }
          }
        ]),
        HAIKU,
        'conversation-1',
        undefined,
        KIRO_PLACEHOLDER_TOOL_NAME
      )
    )

    expect(toolNames(chunks)).toEqual(['search_docs'])
    const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason)
    expect(finish.choices[0].finish_reason).toBe('tool_calls')
  })

  test('drops the placeholder in non-streaming SDK responses', async () => {
    const response = await new ResponseHandler().handleSdkSuccess(
      sdkStreamOf([
        { assistantResponseEvent: { content: 'Fix Docker Build' } },
        {
          toolUseEvent: {
            name: KIRO_PLACEHOLDER_TOOL_NAME,
            toolUseId: 'placeholder-1',
            input: '{}',
            stop: true
          }
        }
      ]),
      HAIKU,
      'conversation-1',
      false,
      undefined,
      KIRO_PLACEHOLDER_TOOL_NAME
    )
    const body: any = await response.json()

    expect(body.choices[0].message.content).toBe('Fix Docker Build')
    expect(body.choices[0].message.tool_calls).toBeUndefined()
    expect(body.choices[0].finish_reason).toBe('stop')
  })

  test('drops the placeholder in the raw HTTP event stream', async () => {
    const response = rawStreamOf([
      { content: 'Fix Docker Build' },
      {
        name: KIRO_PLACEHOLDER_TOOL_NAME,
        toolUseId: 'placeholder-1',
        input: '{}',
        stop: true
      }
    ])

    const chunks = await collect(
      transformKiroStream(response, HAIKU, 'conversation-1', undefined, KIRO_PLACEHOLDER_TOOL_NAME)
    )

    expect(toolNames(chunks)).toEqual([])
    const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason)
    expect(finish.choices[0].finish_reason).toBe('stop')
  })
})
