// import json, os, asyncio, sys, traceback
// from dataclasses import dataclass
// from enum import Enum
// from typing import Union, List
// from statistics import mean, median, stdev
// from flask import Flask, request, jsonify, render_template
// from flask_cors import CORS
// from chainforge.promptengine.query import PromptLLM, PromptLLMDummy, LLMResponseException
// from chainforge.promptengine.template import PromptTemplate, PromptPermutationGenerator
// from chainforge.promptengine.utils import LLM, is_valid_filepath, get_files_at_dir, create_dir_if_not_exists, set_api_keys

import { mean as __mean, std as __std, median as __median } from "mathjs";

import { Dict, LLMResponseError, LLMResponseObject, StandardizedLLMResponse } from "./typing";
import { LLM } from "./models";
import { APP_IS_RUNNING_LOCALLY, getEnumName, set_api_keys } from "./utils";
import StorageCache from "./cache";
import { PromptPipeline } from "./query";
import { PromptPermutationGenerator, PromptTemplate } from "./template";

// """ =================
//     SETUP AND GLOBALS
//     =================
// """

/** Where the ChainForge Flask server is being hosted. */
export const FLASK_BASE_URL = 'http://localhost:8000/';

let LLM_NAME_MAP = {};
Object.entries(LLM).forEach(([key, value]) => {
  LLM_NAME_MAP[value] = key;
});

enum MetricType {
  KeyValue = 0,
  KeyValue_Numeric = 1,
  KeyValue_Categorical = 2,
  KeyValue_Mixed = 3,
  Numeric = 4,
  Categorical = 5,
  Mixed = 6,
  Unknown = 7,
  Empty = 8,
}

// """ ==============
//     UTIL FUNCTIONS
//     ==============
// """

// Store the original console log funcs once upon load,
// to ensure we can always revert to them:
const ORIGINAL_CONSOLE_LOG_FUNCS: Dict = console.log ? {
  log: console.log,
  warn: console.warn,
  error: console.error,
} : {};
let HIJACKED_CONSOLE_LOGS: Dict = {};

function HIJACK_CONSOLE_LOGGING(id: string): void {
  // This function body is adapted from designbyadrian 
  // @ GitHub: https://gist.github.com/designbyadrian/2eb329c853516cef618a  
  HIJACKED_CONSOLE_LOGS[id] = [];

  if (ORIGINAL_CONSOLE_LOG_FUNCS.log) {
    let cl = ORIGINAL_CONSOLE_LOG_FUNCS.log;
    console.log = function() {
      const a = Array.from(arguments).map(s => s.toString());
      HIJACKED_CONSOLE_LOGS[id].push(a.length === 1 ? a[0] : a);
      cl.apply(this, arguments);
    }
  }

  if (ORIGINAL_CONSOLE_LOG_FUNCS.warn) {
    let cw = ORIGINAL_CONSOLE_LOG_FUNCS.warn;
    console.warn = function() {
      const a = Array.from(arguments).map(s => `warn: ${s.toString()}`);
      HIJACKED_CONSOLE_LOGS[id].push(a.length === 1 ? a[0] : a);
      cw.apply(this, arguments);
    }
  }

  if (ORIGINAL_CONSOLE_LOG_FUNCS.error) {
    let ce = ORIGINAL_CONSOLE_LOG_FUNCS.error;
    console.error = function() {
      const a = Array.from(arguments).map(s => `error: ${s.toString()}`);
      HIJACKED_CONSOLE_LOGS[id].push(a.length === 1 ? a[0] : a);
      ce.apply(this, arguments);
    }
  }
}

function REVERT_CONSOLE_LOGGING(id: string): any[] {
  if (ORIGINAL_CONSOLE_LOG_FUNCS.log !== undefined)
    console.log = ORIGINAL_CONSOLE_LOG_FUNCS.log;
  if (ORIGINAL_CONSOLE_LOG_FUNCS.warn !== undefined)
    console.warn = ORIGINAL_CONSOLE_LOG_FUNCS.warn;
  if (ORIGINAL_CONSOLE_LOG_FUNCS.log !== undefined)
    console.error = ORIGINAL_CONSOLE_LOG_FUNCS.error;
  
  const logs = HIJACKED_CONSOLE_LOGS[id];
  delete HIJACKED_CONSOLE_LOGS[id];
  return logs;
}

/** Stores info about a single LLM response. Passed to evaluator functions. */
export class ResponseInfo {
  text: string;  // The text of the LLM response
  prompt: string  // The text of the prompt using to query the LLM
  var: Dict  // A dictionary of arguments that filled in the prompt template used to generate the final prompt
  meta: Dict  // A dictionary of metadata ('metavars') that is 'carried alongside' data used to generate the prompt
  llm: string | LLM  // The name of the LLM queried (the nickname in ChainForge)

  constructor(text: string, prompt: string, _var: Dict, meta: Dict, llm: string | LLM) {
    this.text = text;
    this.prompt = prompt;
    this.var = _var;
    this.meta = meta;
    this.llm = llm;
  }

  toString(): string {
    return this.text;
  }

  // TODO: REIMPLEMENT WITH MARKED.JS
  // def asMarkdownAST(self):
  //     import mistune
  //     md_ast_parser = mistune.create_markdown(renderer='ast')
  //     return md_ast_parser(self.text)
}

function to_standard_format(r: LLMResponseObject | Dict): StandardizedLLMResponse {
  let resp_obj = {
    vars: r['info'],
    metavars: r['metavars'] || {},
    llm: r['llm'],
    prompt: r['prompt'],
    responses: r['responses'],
    tokens: r.raw_response?.usage || {},
  };
  if ('eval_res' in r)
    resp_obj['eval_res'] = r['eval_res'];
  return resp_obj;
}

function get_cache_keys_related_to_id(cache_id: string, include_basefile: boolean=true): string[] {
  // Load the base cache 'file' for cache_id
  const base_file = `${cache_id}.json`;
  const data = StorageCache.get(base_file);
  if (data?.cache_files !== undefined)
    return Object.keys(data.cache_files).concat((include_basefile ? [base_file] : []));
  else
    return include_basefile ? [base_file] : [];
}

// def remove_cached_responses(cache_id: str):
//     cache_files = get_cache_keys_related_to_id(cache_id)
//     for filename in cache_files:
//         os.remove(os.path.join(CACHE_DIR, filename))

/**
 * Loads the cache JSON file at filepath. 
 * 'Soft fails' if the file does not exist (returns empty object).
 */
function load_from_cache(storageKey: string): Dict {
    return StorageCache.get(storageKey) || {};
}

function load_cache_responses(storageKey: string): Array<Dict> {
  const data = load_from_cache(storageKey);
  if (Array.isArray(data))
    return data;
  else if (typeof data === 'object' && data.responses_last_run !== undefined)
    return data.responses_last_run;
  throw new Error(`Could not find cache file for id ${storageKey}`);
}

function gen_unique_cache_filename(cache_id: string, prev_filenames: Array<string>): string {
  let idx = 0;
  prev_filenames.forEach(f => {
    const lhs = f.split('.')[0];
    const num = parseInt(lhs.split('_').pop() as string);
    idx = Math.max(num+1, idx);
  }); 
  return `${cache_id}_${idx}.json`;
}

function extract_llm_nickname(llm_spec: Dict | string) {
  if (typeof llm_spec === 'object' && llm_spec.name !== undefined)
    return llm_spec.name;
  else
    return llm_spec;
}

function extract_llm_name(llm_spec: Dict | string): string {
  if (typeof llm_spec === 'string')
    return llm_spec;
  else
    return llm_spec.model;
}

function extract_llm_key(llm_spec: Dict | string): string {
  if (typeof llm_spec === 'string')
    return llm_spec;
  else if (llm_spec.key !== undefined)
    return llm_spec.key;
  else
    throw new Error(`Could not find a key property on spec ${JSON.stringify(llm_spec)} for LLM`);
}

function extract_llm_params(llm_spec: Dict | string): Dict {
  if (typeof llm_spec === 'object' && llm_spec.settings !== undefined)
    return llm_spec.settings;
  else
    return {};
}

/**
 * Test equality akin to Python's list equality.
 */
function isLooselyEqual(value1: any, value2: any): boolean {
  // If both values are non-array types, compare them directly
  if (!Array.isArray(value1) && !Array.isArray(value2)) {
    return value1 === value2;
  }

  // If either value is not an array or their lengths differ, they are not equal
  if (!Array.isArray(value1) || !Array.isArray(value2) || value1.length !== value2.length) {
    return false;
  }

  // Compare each element in the arrays recursively
  for (let i = 0; i < value1.length; i++) {
    if (!isLooselyEqual(value1[i], value2[i])) {
      return false;
    }
  }

  // All elements are equal
  return true;
}

/**
 * Given a cache'd response object, and an LLM name and set of parameters (settings to use), 
 * determines whether the response query used the same parameters.
 */
function matching_settings(cache_llm_spec: Dict | string, llm_spec: Dict | string): boolean {
  if (extract_llm_name(cache_llm_spec) !== extract_llm_name(llm_spec))
    return false;
  if (typeof llm_spec === 'object' && typeof cache_llm_spec === 'object') {
    const llm_params = extract_llm_params(llm_spec);
    const cache_llm_params = extract_llm_params(cache_llm_spec);
    for (const [param, val] of Object.entries(llm_params))
        if (param in cache_llm_params && !isLooselyEqual(cache_llm_params[param], val)) {
          return false;
        }
  }
  return true;
}

function areSetsEqual(xs: Set<any>, ys: Set<any>): boolean {
    return xs.size === ys.size && [...xs].every((x) => ys.has(x));
}

function check_typeof_vals(arr: Array<any>): MetricType {
  if (arr.length === 0) return MetricType.Empty;

  const typeof_set: (types: Set<any>) => MetricType = (types: Set<any>) => {
    if (types.size === 0) return MetricType.Empty;
    if (types.size === 1 && typeof types.values()[0] === 'object' && !Array.isArray(types.values()[0]))
      return MetricType.KeyValue;
    else if (Array.from(types).every(t => typeof t === 'number'))
      // Numeric metrics only
      return MetricType.Numeric;
    else if (Array.from(types).every(t => ['string', 'boolean'].includes(typeof t)))
      // Categorical metrics only ('bool' is True/False, counts as categorical)
      return MetricType.Categorical;
    else if (Array.from(types).every(t => ['string', 'boolean', 'number'].includes(typeof t)))
      // Mix of numeric and categorical types
      return MetricType.Mixed;
    else
      //Mix of types beyond basic ones
      return MetricType.Unknown;
  };
  
  const typeof_dict_vals = (d: Dict) => {
    const dict_val_type = typeof_set(new Set(d.values()));
    if (dict_val_type === MetricType.Numeric)
      return MetricType.KeyValue_Numeric;
    else if (dict_val_type === MetricType.Categorical)
      return MetricType.KeyValue_Categorical;
    else
      return MetricType.KeyValue_Mixed;
  };
      
  // Checks type of all values in 'arr' and returns the type
  const val_type = typeof_set(new Set(arr));
  if (val_type === MetricType.KeyValue) {
      // This is a 'KeyValue' pair type. We need to find the more specific type of the values in the dict.
      // First, we check that all dicts have the exact same keys
      for (let i = 0; i < arr.length-1; i++) {
        const d = arr[i];
        const e = arr[i+1];
        if (!areSetsEqual(d, e))
          throw new Error('The keys and size of dicts for evaluation results must be consistent across evaluations.');
      }
      
      // Then, we check the consistency of the type of dict values:
      const first_dict_val_type = typeof_dict_vals(arr[0]);
      arr.slice(1).forEach((d: Dict) => {
        if (first_dict_val_type !== typeof_dict_vals(d))
          throw new Error('Types of values in dicts for evaluation results must be consistent across responses.');
      });

      // If we're here, all checks passed, and we return the more specific KeyValue type:
      return first_dict_val_type;
  } else
    return val_type;
}

function run_over_responses(eval_func: (resp: ResponseInfo) => any, responses: Array<StandardizedLLMResponse>): Array<StandardizedLLMResponse> {
  const evald_responses = responses.map((_resp_obj: StandardizedLLMResponse) => {
    // Deep clone the response object
    const resp_obj = JSON.parse(JSON.stringify(_resp_obj));

    // Map the evaluator func over every individual response text in each response object
    const res = resp_obj.responses;
    const evals = res.map(
      (r: string) => eval_func(new ResponseInfo(r, 
                                                resp_obj.prompt, 
                                                resp_obj.vars, 
                                                resp_obj.metavars || {}, 
                                                extract_llm_nickname(resp_obj.llm))
    ));

    // Check the type of evaluation results
    // NOTE: We assume this is consistent across all evaluations, but it may not be.
    const eval_res_type = check_typeof_vals(evals);

    if (eval_res_type === MetricType.Numeric) {
        // Store items with summary of mean, median, etc
        resp_obj.eval_res = {
          mean: __mean(evals),
          median: __median(evals), 
          stdev: (evals.length > 1 ? __std(evals) : 0),
          range: [Math.min(...evals), Math.max(...evals)],
          items: evals,
          dtype: getEnumName(MetricType, eval_res_type),
        };
    } else if ([MetricType.Unknown, MetricType.Empty].includes(eval_res_type))
      throw new Error('Unsupported types found in evaluation results. Only supported types for metrics are: int, float, bool, str.');
    else {
      // Categorical, KeyValue, etc, we just store the items:
      resp_obj.eval_res = { 
        items: evals,
        dtype: getEnumName(MetricType, eval_res_type),
      }
    }

    return resp_obj;
  });

  return evald_responses;
}

// """ ===================
//     BACKEND FUNCTIONS
//     ===================
// """

/**
 * Calculates how many queries we need to make, given the passed prompt and vars.
 * 
 * @param prompt the prompt template, with any {{}} vars
 * @param vars a dict of the template variables to fill the prompt template with, by name. 
 *             For each var value, can be single values or a list; in the latter, all permutations are passed. (Pass empty dict if no vars.)
 * @param llms the list of LLMs you will query
 * @param n how many responses expected per prompt
 * @param id (optional) a unique ID of the node with cache'd responses. If missing, assumes no cache will be used.
 * @returns If success, a dict with { counts: <dict of missing queries per LLM>, total_num_responses: <dict of total num responses per LLM> }
 *          If there was an error, returns a dict with a single key, 'error'. 
 */
export async function countQueries(prompt: string, vars: Dict, llms: Array<Dict | string>, n: number, id?: string): Promise<Dict> {
  let gen_prompts: PromptPermutationGenerator;
  let all_prompt_permutations: Array<PromptTemplate>;
  try {
    gen_prompts = new PromptPermutationGenerator(prompt);
    all_prompt_permutations = Array.from(gen_prompts.generate(vars));
  } catch (err) {
    return {error: err.message};
  }
  
  let cache_file_lookup: Dict = {};
  if (id !== undefined) {
    const cache_data = load_from_cache(`${id}.json`);
    cache_file_lookup = cache_data?.cache_files || {};
  }
  
  let missing_queries = {};
  let num_responses_req = {};
  const add_to_missing_queries = (llm_key: string, prompt: string, num: number) => {
    if (!(llm_key in missing_queries))
      missing_queries[llm_key] = {};
    missing_queries[llm_key][prompt] = num;
  };
  const add_to_num_responses_req = (llm_key: string, num: number) => {
    if (!(llm_key in num_responses_req))
      num_responses_req[llm_key] = 0;
    num_responses_req[llm_key] += num;
  }
  
  llms.forEach(llm_spec => {
    const llm_key = extract_llm_key(llm_spec);

    // Find the response cache file for the specific LLM, if any
    let found_cache = false;
    for (const [cache_filename, cache_llm_spec] of Object.entries(cache_file_lookup)) {
      if (matching_settings(cache_llm_spec, llm_spec)) {
        found_cache = true;

        // Load the cache file
        const cache_llm_responses = load_from_cache(cache_filename);

        // Iterate through all prompt permutations and check if how many responses there are in the cache with that prompt
        all_prompt_permutations.forEach(perm => {
          const prompt_str = perm.toString();

          add_to_num_responses_req(llm_key, n);

          if (prompt_str in cache_llm_responses) {
            // Check how many were stored; if not enough, add how many missing queries:
            const num_resps = cache_llm_responses[prompt_str]['responses'].length;
            if (n > num_resps)
              add_to_missing_queries(llm_key, prompt_str, n - num_resps);
          } else {
            add_to_missing_queries(llm_key, prompt_str, n);
          }
        });
        
        break;
      }
    }
    
    if (!found_cache) {
      all_prompt_permutations.forEach(perm => {
        add_to_num_responses_req(llm_key, n);
        add_to_missing_queries(llm_key, perm.toString(), n);
      });
    }
  });
  
  console.log(missing_queries);

  return {'counts': missing_queries, 'total_num_responses': num_responses_req};
}

export function createProgressFile(id: string): void {
  // do nothing --this isn't needed for the JS backend, but was for the Python one
}

interface LLMPrompterResults {
  llm_key: string,
  responses: Array<LLMResponseObject>,
  errors: Array<string>,
}

export async function fetchEnvironAPIKeys(): Promise<Dict> {
  return fetch(`${FLASK_BASE_URL}app/fetchEnvironAPIKeys`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
    body: "",
  }).then(res => res.json());
}

/**
 * Queries LLM(s) with root prompt template `prompt` and prompt input variables `vars`, `n` times per prompt.
 * Soft-fails if API calls fail, and collects the errors in `errors` property of the return object.
 * 
 * @param id a unique ID to refer to this information. Used when cache'ing responses. 
 * @param llm a string, list of strings, or list of LLM spec dicts specifying the LLM(s) to query.
 * @param n the amount of generations for each prompt. All LLMs will be queried the same number of times 'n' per each prompt.
 * @param prompt the prompt template, with any {{}} vars
 * @param vars a dict of the template variables to fill the prompt template with, by name. 
               For each var, can be single values or a list; in the latter, all permutations are passed. (Pass empty dict if no vars.)
 * @param api_keys (optional) a dict of {api_name: api_key} pairs. Supported key names: OpenAI, Anthropic, Google
 * @param no_cache (optional) if true, deletes any cache'd responses for 'id' (always calls the LLMs fresh)
 * @returns a dictionary in format `{responses: StandardizedLLMResponse[], errors: string[]}`
 */
export async function queryLLM(id: string, 
                               llm: string | Array<string> | Array<Dict>,
                               n: number, 
                               prompt: string,
                               vars: Dict,
                               api_keys?: Dict,
                               no_cache?: boolean,
                               progress_listener?: (progress: {[key: symbol]: any}) => void): Promise<Dict> {
  // Verify the integrity of the params
  if (typeof id !== 'string' || id.trim().length === 0)
    return {'error': 'id is improper format (length 0 or not a string)'};

  if (Array.isArray(llm) && llm.length === 0)
    return {'error': 'POST data llm is improper format (not string or list, or of length 0).'};
  
  // Ensure llm param is an array
  if (typeof llm === 'string')
    llm = [ llm ];
  llm = llm as (Array<string> | Array<Dict>); 
  
  for (let i = 0; i < llm.length; i++) {
    const llm_spec = llm[i];
    if (!(extract_llm_name(llm_spec) in LLM_NAME_MAP)) 
      return {'error': `LLM named '${llm_spec}' is not supported.`};
  }

  if (APP_IS_RUNNING_LOCALLY()) {
    // Try to fetch API keys from os.environ variables in the locally running Flask backend:
    try {
      const api_keys = await fetchEnvironAPIKeys();
      set_api_keys(api_keys);
    } catch (err) {
      console.warn('Warning: Could not fetch API key environment variables from Flask server. Error:', err.message);
      // Soft fail
    }
  }

  if (api_keys !== undefined)
    set_api_keys(api_keys);

  // if 'no_cache' in data and data['no_cache'] is True:
  //     remove_cached_responses(data['id'])
  
  // Get the storage keys of any cache files for specific models + settings
  const llms = llm;
  let cache: Dict = StorageCache.get(`${id}.json`) || {};  // returns {} if 'id' is not in the storage cache yet

  let llm_to_cache_filename = {};
  let past_cache_files = {};
  if (typeof cache === 'object' && cache.cache_files !== undefined) {
    const past_cache_files: Dict = cache.cache_files;
    let past_cache_filenames: Array<string> = Object.keys(past_cache_files);
    llms.forEach(llm_spec => {
      let found_cache = false;
      for (const [filename, cache_llm_spec] of Object.entries(past_cache_files)) {
        if (matching_settings(cache_llm_spec, llm_spec)) {
          llm_to_cache_filename[extract_llm_key(llm_spec)] = filename;
          found_cache = true;
          break;
        }
      }
      if (!found_cache) {
        const new_filename = gen_unique_cache_filename(id, past_cache_filenames);
        llm_to_cache_filename[extract_llm_key(llm_spec)] = new_filename;
        cache.cache_files[new_filename] = llm_spec;
        past_cache_filenames.push(new_filename);
      }
    });    
  } else {
    // Create a new cache JSON object
    cache = { cache_files: {}, responses_last_run: [] };
    let prev_filenames: Array<string> = [];
    llms.forEach((llm_spec: string | Dict) => {
      const fname = gen_unique_cache_filename(id, prev_filenames);
      llm_to_cache_filename[extract_llm_key(llm_spec)] = fname;
      cache.cache_files[fname] = llm_spec;
      prev_filenames.push(fname);
    });
  }

  // Store the overall cache file for this id:
  StorageCache.store(`${id}.json`, cache);

  // Create a Proxy object to 'listen' for changes to a variable (see https://stackoverflow.com/a/50862441)
  // and then stream those changes back to a provided callback used to update progress bars.
  let progress = {};
  let progressProxy = new Proxy(progress, {
    set: function (target, key, value) {
      target[key] = value;

      // If the caller provided a callback, notify it 
      // of the changes to the 'progress' object:
      if (progress_listener)
        progress_listener(target);

      return true;
    }
  });

  // For each LLM, generate and cache responses:
  let responses: {[key: string]: Array<LLMResponseObject>} = {};
  let all_errors = {};
  let num_generations = n !== undefined ? n : 1;
  async function query(llm_spec: string | Dict): Promise<LLMPrompterResults> {
    // Get LLM model name and any params
    let llm_str = extract_llm_name(llm_spec);
    let llm_nickname = extract_llm_nickname(llm_spec);
    let llm_params = extract_llm_params(llm_spec);
    let llm_key = extract_llm_key(llm_spec);
    let temperature: number = llm_params?.temperature !== undefined ? llm_params.temperature : 1.0;

    // Create an object to query the LLM, passing a storage key for cache'ing responses
    const cache_filepath = llm_to_cache_filename[llm_key];
    const prompter = new PromptPipeline(prompt, cache_filepath);

    // Prompt the LLM with all permutations of the input prompt template:
    // NOTE: If the responses are already cache'd, this just loads them (no LLM is queried, saving $$$)
    let resps: Array<LLMResponseObject> = [];
    let errors: Array<string> = [];
    let num_resps = 0;
    let num_errors = 0;
    try {
      console.log(`Querying ${llm_str}...`)

      // Yield responses for 'llm' for each prompt generated from the root template 'prompt' and template variables in 'properties':
      for await (const response of prompter.gen_responses(vars, llm_str as LLM, num_generations, temperature, llm_params)) {
        // Check for selective failure
        if (response instanceof LLMResponseError) {  // The request failed
          console.error(`error when fetching response from ${llm_str}: ${response.message}`);
          num_errors += 1;
          errors.push(response.message);
        } else {  // The request succeeded
          // The response name will be the actual name of the LLM. However,
          // for the front-end it is more informative to pass the user-provided nickname. 
          response.llm = llm_nickname;
          num_resps += response.responses.length;
          resps.push(response);
        }

        // Update the current 'progress' for this llm.
        // (this implicitly triggers any callbacks defined in the Proxy)
        progressProxy[llm_key] = {
          success: num_resps,
          error: num_errors
        };
      }
    } catch (e) {
      console.error(`Error generating responses for ${llm_str}: ${e.message}`);
      throw e;
    }

    return {
      llm_key: llm_key, 
      responses: resps, 
      errors: errors };
  }
      
  try {
    // Request responses simultaneously across LLMs
    let tasks: Array<Promise<LLMPrompterResults>> = llms.map(query);

    // Await the responses from all queried LLMs
    const llm_results = await Promise.all(tasks);
    llm_results.forEach(result => {
      responses[result.llm_key] = result.responses;
      if (result.errors.length > 0)
        all_errors[result.llm_key] = result.errors;
    });
  } catch (e) {
    console.error(`Error requesting responses: ${e.message}`);
    return { error: e.message };
  }

  // Convert the responses into a more standardized format with less information
  const res = Object.values(responses).flatMap(rs => rs.map(to_standard_format));
  
  // Save the responses *of this run* to the storage cache, for further recall:
  let cache_filenames = past_cache_files;
  llms.forEach((llm_spec: string | Dict) => {
    const filename = llm_to_cache_filename[extract_llm_key(llm_spec)];
    cache_filenames[filename] = llm_spec;
  });

  StorageCache.store(`${id}.json`, {
    cache_files: cache_filenames,
    responses_last_run: res,
  });
  
  // Return all responses for all LLMs
  return {
    responses: res, 
    errors: all_errors
  };
}

/**
 * Executes a Javascript 'evaluate' function over all cache'd responses with given id's.
 * 
 * Similar to Flask backend's Python 'execute' function, except requires code to be in Javascript.
 * 
 * > **NOTE**: This should only be run on code you trust. 
 *             There is no sandboxing; no safety. We assume you are the creator of the code.
 * 
 * @param id a unique ID to refer to this information. Used when cache'ing evaluation results. 
 * @param code the code to evaluate. Must include an 'evaluate()' function that takes a 'response' of type ResponseInfo. Alternatively, can be the evaluate function itself.
 * @param response_ids the cache'd response to run on, which must be a unique ID or list of unique IDs of cache'd data
 * @param scope the scope of responses to run on --a single response, or all across each batch. (If batch, evaluate() func has access to 'responses'.)
 */
export async function executejs(id: string, 
                                code: string | ((rinfo: ResponseInfo) => any), 
                                response_ids: string | string[], 
                                scope: 'response' | 'batch'): Promise<Dict> {
  // Check format of response_ids
  if (!Array.isArray(response_ids))
    response_ids = [ response_ids ];
  response_ids = response_ids as Array<string>;

  console.log('executing js');

  // const iframe = document.createElement('iframe');

  // Instantiate the evaluator function by eval'ing the passed code
  // DANGER DANGER!!
  let iframe: HTMLElement | undefined;
  if (typeof code === 'string') {
    try {
        /*
          To run Javascript code in a psuedo-'sandbox' environment, we
          can use an iframe and run eval() inside the iframe, instead of the current environment.
          This is slightly safer than using eval() directly, doesn't clog our namespace, and keeps
          multiple Evaluate node execution environments separate. 
          
          The Evaluate node in the front-end has a hidden iframe with the following id. 
          We need to get this iframe element. 
        */
        iframe = document.getElementById(`${id}-iframe`);
        if (!iframe)
          throw new Error("Could not find iframe sandbox for evaluator node.");

        // Now run eval() on the 'window' of the iframe:
        // @ts-ignore
        iframe.contentWindow.eval(code);

        // Now check that there is an 'evaluate' method in the iframe's scope.
        // NOTE: We need to tell Typescript to ignore this, since it's a dynamic type check.
        // @ts-ignore
        if (iframe.contentWindow.evaluate === undefined) {
          throw new Error('evaluate() function is undefined.');
        }
    } catch (err) {
      return {'error': `Could not compile evaluator code. Error message:\n${err.message}`};
    }
  }

  // Load all responses with the given ID:
  let all_evald_responses: StandardizedLLMResponse[] = [];
  let all_logs: string[] = [];
  for (let i = 0; i < response_ids.length; i++) {
    const cache_id = response_ids[i];
    const fname = `${cache_id}.json`;
    if (!StorageCache.has(fname))
      return {error: `Did not find cache file for id ${cache_id}`, logs: all_logs};

    // Load the raw responses from the cache
    const responses = load_cache_responses(fname);
    if (responses.length === 0)
      continue;

    let evald_responses: StandardizedLLMResponse[];
    try {
      // Intercept any calls to console.log, .warn, or .error, so we can store the calls
      // and print them in the 'output' footer of the Evaluator Node: 
      HIJACK_CONSOLE_LOGGING(id);

      // Run the user-defined 'evaluate' function over the responses: 
      // NOTE: 'evaluate' here was defined dynamically from 'eval' above. We've already checked that it exists. 
      // @ts-ignore
      evald_responses = run_over_responses((iframe ? iframe.contentWindow.evaluate : code), responses, scope);

      // Revert the console.log, .warn, .error back to browser default:
      all_logs = all_logs.concat(REVERT_CONSOLE_LOGGING(id));
    } catch (err) {
      all_logs = all_logs.concat(REVERT_CONSOLE_LOGGING(id));
      return { error: `Error encountered while trying to run "evaluate" method:\n${err.message}`, logs: all_logs };
    }

    all_evald_responses = all_evald_responses.concat(evald_responses);
  }

  // Store the evaluated responses in a new cache json:
  StorageCache.store(`${id}.json`, all_evald_responses);

  return {responses: all_evald_responses, logs: all_logs};
}

/**
 * Returns all responses with the specified id(s).
 * @param responses the ids to grab
 * @returns If success, a Dict with a single key, 'responses', with an array of StandardizedLLMResponse objects
 *          If failure, a Dict with a single key, 'error', with the error message.
 */
export async function grabResponses(responses: Array<string>): Promise<Dict> {
  // Grab all responses with the given ID:
  let grabbed_resps = [];
  for (let i = 0; i < responses.length; i++) {
    const cache_id = responses[i];
    const storageKey = `${cache_id}.json`;
    if (!StorageCache.has(storageKey))
      return {error: `Did not find cache data for id ${cache_id}`};
    
    let res: Dict[] = load_cache_responses(storageKey);
    if (typeof res === 'object' && !Array.isArray(res)) {
        // Convert to standard response format
        Object.entries(res).map(([prompt, res_obj]: [string, Dict]) => to_standard_format({prompt: prompt, ...res_obj}));
    }
    grabbed_resps = grabbed_resps.concat(res);
  }

  return {'responses': grabbed_resps};
}

/**
 * Exports the cache'd data relevant to the given node id(s).
 * 
 * @param ids the ids of the nodes to export data for
 * @returns the cache'd data, as a JSON dict in format `{ files: { filename: <Dict|Array> } }`
 */
export async function exportCache(ids: string[]) {
  // For each id, extract relevant cache file data
  let export_data = {};
  for (let i = 0; i < ids.length; i++) {
    const cache_id = ids[i];
    const cache_keys = get_cache_keys_related_to_id(cache_id);
    if (cache_keys.length === 0) {
        console.warn(`Warning: Could not find cache data for id '${cache_id}'. Skipping...`);
        continue;
    }
    cache_keys.forEach((key: string) => {
      export_data[key] = load_from_cache(key);
    });
  }
  return export_data;
}


/**
 * Imports the passed data relevant to specific node id(s), and saves on the backend cache.
 * Used for importing data from an exported flow, so that the flow is self-contained.
 * 
 * @param files the name and contents of the cache file
 * @returns Whether the import succeeded or not.
 */
export async function importCache(files: { [key: string]: Dict | Array<any> }): Promise<Dict> {
  try {
    // Write imported files to StorageCache
    // Verify filenames, data, and access permissions to write to cache
    Object.entries(files).forEach(([filename, data]) => {
      console.log('storing file', filename);
      StorageCache.store(filename, data);
    });
  } catch (err) {
    console.error('Error importing from cache:', err.message);
    return { result: false };
  }
  
  console.log("Imported cache data and stored to cache.");
  return { result: true };
}


/**
 * Fetches the example flow data, given its filename (without extension). 
 * The filename should be the name of a file in the examples/ folder of the package. 
 * 
 * @param _name The filename (without .cforge extension)
 * @returns a Promise with the JSON of the loaded data
 */
export async function fetchExampleFlow(evalname: string): Promise<Dict> {    
  if (APP_IS_RUNNING_LOCALLY()) {
    // Attempt to fetch the example flow from the local filesystem
    // by querying the Flask server: 
    return fetch(`${FLASK_BASE_URL}app/fetchExampleFlow`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
      body: JSON.stringify({ name: evalname })
    }).then(function(res) {
      return res.json();
    });
  }

  // App is not running locally, but hosted on a site.
  // If this is the case, attempt to fetch the example flow from a relative site path:
  return fetch(`examples/${evalname}.cforge`).then(response => response.json());
}


/**
 * Fetches a preconverted OpenAI eval as a .cforge JSON file.

   First checks if it's running locally; if so, defaults to Flask backend for this bunction.
   Otherwise, tries to fetch the eval from a relative path on the website. 

 * @param _name The name of the eval to grab (without .cforge extension)
 * @returns a Promise with the JSON of the loaded data
 */
export async function fetchOpenAIEval(evalname: string): Promise<Dict> {
  if (APP_IS_RUNNING_LOCALLY()) {
    // Attempt to fetch the example flow from the local filesystem
    // by querying the Flask server: 
    return fetch(`${FLASK_BASE_URL}app/fetchOpenAIEval`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
      body: JSON.stringify({ name: evalname })
    }).then(function(res) {
      return res.json();
    });
  }

  // App is not running locally, but hosted on a site.
  // If this is the case, attempt to fetch the example flow from relative path on the site:
  //  > ALT: `https://raw.githubusercontent.com/ianarawjo/ChainForge/main/chainforge/oaievals/${_name}.cforge`
  return fetch(`oaievals/${evalname}.cforge`).then(response => response.json());
}
