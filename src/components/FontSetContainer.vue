<template>
    <div class="row">
        <div class="column">
            <div class="alertBox">
                <div class="info_container">
                    <h3>{{fontset.name}}</h3>
                    <p class="subtext" v-if="fontset.designers.length > 0">
                        by 
                        <span v-for="(designer, key) in fontset.designers"><a v-bind:href="designer.url">{{designer.name}}</a><span v-if="key < fontset.designers.length -1">, </span></span>
                    </p>
                </div>
                <div class="button_container">
                    <a class="button" :class="{ disabled: downloading }" v-on:click="download(fontset.fonts, fontset.name, 'zip')">{{ downloading ? 'Preparing…' : 'Download All (.zip)' }}</a>
                    <a class="button" :class="{ disabled: downloading }" v-on:click="download(fontset.fonts, fontset.name, 'unify')" title="Renames every weight to share one family name so they install and group as a single family (Futura → Light, Bold, … instead of separate families).">{{ downloading ? 'Preparing…' : 'Merge into one family (.zip)' }}</a>
                </div>
            </div>
        </div>
    </div>
    <div class="row" v-for="(chunk, c_key) in getFontsInChunks(3)">
        <FontBox v-for="(font, f_key) in chunk" v-bind:key="(c_key * 3) + f_key" v-on:download="download([font], font.name, 'single')" v-bind:fontname="font.name" v-bind:fontstyle="font.style" v-bind:fonturl="font.url" v-bind:sampletext="fontset.sampletext" v-bind:familyurl="font.familyUrl"></FontBox>
    </div>
</template>

<script>
export default {
    name: "FontSetContainer",
    props: ['fontset', 'downloading'],
    emits: ['download'],
    methods: {
        download(fonts, family_name, mode) {
            if (this.downloading) return
            this.$emit('download', fonts, family_name, mode)
        },
        getFontsInChunks: function(chunkSize_) {
            let output = []
            if(this.fontset.fonts != null) {
                for(var i = 0; i < this.fontset.fonts.length; i++) {
                    if(i % chunkSize_ == 0 ){
                        output.push([]);
                    }
                    output[Math.floor(i / chunkSize_)].push(this.fontset.fonts[i])
                }
                return output
            }
            return []
        }
    }
}
</script>

<script setup>
import FontBox from './FontBox.vue';
</script>
