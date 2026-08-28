export {
	type ConvertToHtmlOptions,
	convertToHtml,
	type DocxImage,
	type DocxInput,
	type DocxMessage,
	type DocxResult,
	type ImageAttributeConverter,
	type ImageAttributes,
	type ImageConverter,
	images,
} from "./docx/converter";

import { convertToHtml, images } from "./docx/converter";

const docx = { convertToHtml, images };

export default docx;
