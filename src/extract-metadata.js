import async from 'async';
import _ from 'lodash';
import sketch from 'sketch';
import sketchDOM from 'sketch/dom';

function exportPNG(image, options) {
    const defaultOptions = {
        formats: "png",
        scale: "1",
        'save-for-web': true
    };

    defaultOptions['save-for-web'] = (!!options && options.formats === 'png');
    sketchDOM.export(image, _.merge(defaultOptions, options));
}

function extractImageMetaData(layer) {
    const frameKeys = ['height', 'width', 'x', 'y']
    const imageStyleKeys = ['opacity'];
    const imageMetaObject = {};

    imageMetaObject.frame = _.pick(layer.frame, frameKeys);
    imageMetaObject.style = _.pick(layer.style, imageStyleKeys);
    exportPNG(layer);

    return (imageMetaObject);
}

function extractTextMetadata(layer) {
    const frameKeys = ['height', 'width', 'x', 'y'];
    const textStyleKeys = ['opacity']

    const textLayerMeta = {
        alignment: layer.alignment,
        frame: _.pick(layer.frame, frameKeys),
        style: _.pick(layer.style, textStyleKeys),
        text: layer.text
    };
    textLayerMeta.style.color = _.get(layer, 'style.fills[0].color');

    return (textLayerMeta);
}

function extractMetaData(layer) {
    /*
        Keys required to be extracted from the text layer
        Text Layer
            |-  alignment
            |-  frame
                |- height
                |- width
                |- x
                |- y
            |-  name
            |-  style
                |-  opacity
                |-  fills
                    |- color
            |-  text

        -----------------------------------------------
        Keys required to be extracted from the image layer
        Image Layer
            |- name
            |- frame
                |- height
                |- width
                |- x
                |- y
            |- image (to be exported directly as PNG)
            |- style (optional)
    */
    const data = {};
    if(layer.type === 'Image') {
        data[layer.name] = extractImageMetaData(layer);
    } else if(layer.type === 'Text') {
        data[layer.name] = extractTextMetadata(layer);
    }

    return (data);
}


export default function(context) {
    // Get wrapped native Document object from Context
    const doc = sketch.fromNative(context.document);
    const page = doc.selectedPage;

    // Hierarchy for extraction
    // Doc -> Page -> Layer/Artboard -> Layer-Group -> Layer -> Metadata
    const layerMetaArr = [];
    _.forEach(page.layers, (board) => {
        _.forEach(board.layers, (layerGroup) => {
            async.each(layerGroup.layers, (layer) => {
                layerMetaArr.push(extractMetaData(layer));
            }, (err) => {
                if(err) {
                    context.document.showMessage(err.message);
                }
            });
        });
    });
    context.document.showMessage('Extracted layer metadata successfully 😎');
};

