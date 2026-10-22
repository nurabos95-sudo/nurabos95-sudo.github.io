// Einstieg für Cloudflare: Wörterbücher (Bloom-Filter, tools/make_bloom.py) laden, dann der eigentliche Worker
import worker from "./worker.js";
import { setBlooms } from "./verify.js";
import de from "../dict/de.bin";
import en from "../dict/en.bin";
import es from "../dict/es.bin";
import fr from "../dict/fr.bin";
import pt from "../dict/pt.bin";
setBlooms({ de, en, es, fr, pt });
export default worker;
